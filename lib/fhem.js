'use strict';

var util = require('util');
var version = require('./version');
var database = require('./database');

module.exports = {
    FHEM: FHEM,
    FHEM_execute: FHEM_execute,
    FHEM_registerSyncFinishedListener: registerSyncFinishedListener
};

var FHEM_longpoll = {};
var FHEM_csrfToken = {};
var FHEM_informids = {};
var FHEM_informidVal = {};
var FHEM_activeDevices = {};
var FHEM_connectionAuth = {};

//KEEP
function FHEM(log, config) {
    this.log = log;
    this.config = config;
    this.server = config['server'];
    this.port = config['port'];
    this.filter = config['filter'];

    var base_url = 'http://';
    if (config.ssl) {
        if (typeof config.ssl !== 'boolean') {
            this.log.error('config: value for ssl has to be boolean.');
            process.exit(0);
        }
        base_url = 'https://';
    }
    base_url += this.server + ':' + this.port;

    if (config.webname) {
        base_url += '/' + config.webname;
    } else {
        base_url += '/fhem';
    }
    
    this.connection = {base_url: base_url, log: log, fhem: this};
    var auth = config['auth'];
    if (auth) {
      auth.sendImmediately = false;
    }
    FHEM_connectionAuth[base_url] = auth;

    FHEM_startLongpoll(this.connection);
}

var tzoffset = (new Date()).getTimezoneOffset() * 60000; //offset in milliseconds

//KEEP
function
FHEM_update(informId, device, orig) {
    if (orig === undefined)
        return;

    if (!FHEM_informidVal[informId] || FHEM_informidVal[informId].value != orig) {
      if (FHEM_informidVal[informId]) {
        //informid already updated once
        if ((FHEM_informidVal[informId].time + 30000) > Date.now()) {
          //ein weiteres Update innerhalb von 30s erkannt
          FHEM_informidVal[informId].counter++;
          FHEM_informidVal[informId].value = orig;
          if (FHEM_informidVal[informId].counter > 10) {
            //mehr als 10 Updates innerhalb der letzten 30s
            return;
          } else {
            database.updateInformId(informId, device, orig);
            var date = new Date(Date.now() - tzoffset).toISOString().replace(/T/, ' ').replace(/\..+/, '');
            console.log('  ' + date + ' caching: ' + informId + ': ' + orig);
            return;
          }
        } else {
          if (FHEM_informidVal[informId].counter > 10) {
            FHEM_informidVal[informId] = {
              value: orig,
              time: Date.now(),
              counter: 8
            };
          } else {
            //update after 30s
            FHEM_informidVal[informId] = {
              value: orig,
              time: Date.now(),
              counter: 1
            };
          }
          database.updateInformId(informId, device, orig);
          var date = new Date(Date.now() - tzoffset).toISOString().replace(/T/, ' ').replace(/\..+/, '');
          console.log('  ' + date + ' caching: ' + informId + ': ' + orig);
        }
      } else {
        //informid was never updated
        FHEM_informidVal[informId] = {
          value: orig,
          time: Date.now(),
          counter: 1
        };
  
        database.updateInformId(informId, device, orig);
        var date = new Date(Date.now() - tzoffset).toISOString().replace(/T/, ' ').replace(/\..+/, '');
        console.log('  ' + date + ' caching: ' + informId + ': ' + orig);
      }
    }
}

function registerSyncFinishedListener() {
  database.db.collection(database.getUid()).doc('state').onSnapshot(async (docSnapshot) => {
    console.log('SYNC UPDATED RECEIVED: ' + JSON.stringify(docSnapshot.data()));
    if (docSnapshot.data() && docSnapshot.data().syncactive === 0 && docSnapshot.data().disconnected === 0) {
      await setInformIdsFromFirestore();
    } else {
      FHEM_informids = {};
      FHEM_activeDevices = {};
    }
  });
}

async function setInformIdsFromFirestore() {
  //retrieve informids
  FHEM_informids = {};
  FHEM_activeDevices = {};
  var ref = await database.realdb.ref('users/' + database.getUid() + '/informids/').once('value');
  ref.forEach(function(child) {
    FHEM_informids[child.key] = 1;
    FHEM_activeDevices[child.val().device] = 1;
    console.log('handling informid: ' + child.key);
  });
  //database.db.collection(database.getUid()).doc('devices').collection('informids').get()
  //  .then(refs => {
  //    refs.forEach(ref => {
  //        FHEM_informids[ref.id] = 1;
  //        console.log('handling informid: ' + ref.id);
  //    });
  //  });
}

//KEEP
//FIXME: add filter
function FHEM_startLongpoll(connection) {
    if (!FHEM_longpoll[connection.base_url]) {
        FHEM_longpoll[connection.base_url] = {};
        FHEM_longpoll[connection.base_url].connects = 0;
        FHEM_longpoll[connection.base_url].disconnects = 0;
        FHEM_longpoll[connection.base_url].received_total = 0;
    }
 
    if (FHEM_longpoll[connection.base_url].connected)
        return;
    FHEM_longpoll[connection.base_url].connects++;
    FHEM_longpoll[connection.base_url].received = 0;
    FHEM_longpoll[connection.base_url].connected = true;


    var filter = '.*';
    var since = 'null';
    if (FHEM_longpoll[connection.base_url].last_event_time)
        since = FHEM_longpoll[connection.base_url].last_event_time / 1000;
    var query = '?XHR=1'
        + '&inform=type=status;addglobal=1;filter=' + filter + ';since=' + since + ';fmt=JSON'
        + '&timestamp=' + Date.now();

    var url = encodeURI(connection.base_url + query);
    connection.log('starting longpoll: ' + url);

    var FHEM_longpollOffset = 0;
    var input = '';
    var request = require('request');
    connection.auth = FHEM_connectionAuth[connection.base_url];
    if (connection.auth)
      request = request.defaults({auth: connection.auth, rejectUnauthorized: false});
    request.get({url: url}).on('data', async function (data) {
//console.log( 'data: ' + data );
        if (!data)
            return;

        var length = data.length;
        FHEM_longpoll[connection.base_url].received += length;
        FHEM_longpoll[connection.base_url].received_total += length;

        input += data;

        try {
            var lastEventTime = Date.now();
            for (; ;) {
                var nOff = input.indexOf('\n', FHEM_longpollOffset);
                if (nOff < 0)
                    break;
                var l = input.substr(FHEM_longpollOffset, nOff - FHEM_longpollOffset);
                FHEM_longpollOffset = nOff + 1;
//console.log( 'Rcvd: ' + (l.length>132 ? l.substring(0,132)+'...('+l.length+')':l) );

                if (!l.length)
                    continue;

// console.log(d);
                var d;
                if (l.substr(0, 1) == '[') {
                    try {
                        d = JSON.parse(l);
                    } catch (err) {
                        connection.log('  longpoll JSON.parse: ' + err);
                        continue;
                    }
                } else
                    d = l.split('<<', 3);

                if (d[0].match(/-ts$/))
                    continue;
                if (d[0].match(/^#FHEMWEB:/))
                    continue;
                    
                var match = d[0].match(/([^-]*)-a-room/);
                if (match) {
                  //room update
                  // [ 'XMI_158d0002531704-a-room',
                  //   'Alexa,MiSmartHome',
                  //   'Alexa,MiSmartHome' ]
                  //rooms => d[1];
                  if (d[1]) {
                    var rooms = d[1].split(',');
                    var match2 = connection.fhem.filter.match(/room=(.*)/);
                    if (match2) {
                      if (rooms.indexOf(match2[1]) > -1) {
                        //moved to Google room
                        //send current devices to Firebase
                        await connection.fhem.reload();
                        //wait till syncfinished with await
                        //initiate SYNC
                        await database.initiateSync();
                        console.log(d[0] + ' moved to room ' + match2[1]);
                      } else {
                        //check if device was in the room before
                        if (FHEM_activeDevices[match[1]]) {
                          //removed from Google room
                          //send current devices to Firebase
                          await connection.fhem.reload();
                          //wait till syncfinished with await
                          //initiate SYNC
                          await database.initiateSync();
                          console.log(d[0] + ' removed from room ' + match2[1]);
                        }
                      }
                    }
                  }
                  continue;
                }

                match = d[0].match(/([^-]*)-(.*)/);
                if (!match)
                    continue;
                var device = match[1];
                var reading = match[2];
//console.log( 'device: ' + device );
//console.log( 'reading: ' + reading );
                if (reading === undefined)
                    continue;

                var value = d[1];
//console.log( 'value: ' + value );
                if (value.match(/^set-/))
                    continue;
                
                var informid = d[0].replace(/\.|\#|\[|\]|\$/g, '_');
                if (FHEM_informids[informid]) {
                  FHEM_update(informid, device, value);
                  FHEM_longpoll[connection.base_url].last_event_time = lastEventTime;
                }
            }

        } catch (err) {
            connection.log.error('  error in longpoll connection: ' + err);

        }

        input = input.substr(FHEM_longpollOffset);
        FHEM_longpollOffset = 0;

        FHEM_longpoll[connection.base_url].disconnects = 0;

    }).on('response', function (response) {
        if (response.headers && response.headers['x-fhem-csrftoken'])
            FHEM_csrfToken[connection.base_url] = response.headers['x-fhem-csrftoken'];
        else
            FHEM_csrfToken[connection.base_url] = '';

        connection.fhem.checkAndSetGenericDeviceType();
        
    }).on('end', function () {
        FHEM_longpoll[connection.base_url].connected = false;

        FHEM_longpoll[connection.base_url].disconnects++;
        var timeout = 500 * FHEM_longpoll[connection.base_url].disconnects - 300;
        if (timeout > 30000) timeout = 30000;

        connection.log('longpoll ended, reconnect in: ' + timeout + 'msec');
        setTimeout(function () {
            FHEM_startLongpoll(connection)
        }, timeout);

    }).on('error', function (err) {
        FHEM_longpoll[connection.base_url].connected = false;

        FHEM_longpoll[connection.base_url].disconnects++;
        var timeout = 5000 * FHEM_longpoll[connection.base_url].disconnects;
        if (timeout > 30000) timeout = 30000;

        connection.log('longpoll error: ' + err + ', retry in: ' + timeout + 'msec');
        setTimeout(function () {
            FHEM_startLongpoll(connection)
        }, timeout);

    });
}

//KEEP
FHEM.prototype.execute = function (cmd, callback) {
    FHEM_execute(this.connection, cmd, callback)
};

FHEM.prototype.reload = async function (n) {
  if (n)
      this.log.info('reloading ' + n + ' from ' + this.connection.base_url);
  else
      this.log.info('reloading ' + this.connection.base_url);

  if (n) {
      await this.connection.fhem.connect(undefined, 'NAME=' + n);
  } else {
      await this.connection.fhem.connect();
  }
}

//KEEP
FHEM.prototype.connect = async function (callback, filter) {
    //this.checkAndSetGenericDeviceType();

    if (!filter) filter = this.filter;

    this.devices = [];

    if (FHEM_csrfToken[this.connection.base_url] === undefined) {
        setTimeout(function () {
            this.connection.fhem.connect(callback, filter);
        }.bind(this), 500);
        return;
    }

    this.log.info('Fetching FHEM devices...');

    let cmd = 'jsonlist2';
    if (filter)
        cmd += ' ' + filter;
    if (FHEM_csrfToken[this.connection.base_url])
        cmd += '&fwcsrf=' + FHEM_csrfToken[this.connection.base_url];
    const url = encodeURI(this.connection.base_url + '?cmd=' + cmd + '&XHR=1');
    this.log.info('fetching: ' + url);

    var request = require('request-promise');
    this.connection.auth = FHEM_connectionAuth[this.connection.base_url];
    if (this.connection.auth)
      request = request.defaults({auth: this.connection.auth, rejectUnauthorized: false});
      
    var response = await request({url: url, json: true, gzip: true, resolveWithFullResponse: true});
    if (response.statusCode === 200) {
      var json = response.body;
      // console.log("got json: " + util.inspect(json));
      this.log.info('got: ' + json['totalResultsReturned'] + ' results');
      if (json['totalResultsReturned']) {
        var batch = database.db.batch();
        
        //DELETE current data in database
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('devices').get();
          for (var r of ref.docs) {
            batch.delete(r.ref);
          }
        } catch (err) {
          console.error('Device deletion failed: ' + err);
        }
        
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('attributes').get();
          for (var r of ref.docs) {
            batch.delete(r.ref);
          }
        } catch (err) {
          console.error('Attribute deletion failed: ' + err);
        }
        
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('informids').get();
          for (var r of ref.docs) {
            batch.delete(r.ref);
          }
        } catch (err) {
          console.error('InformIds deletion failed: ' + err);
        }
    
        json['Results'].map(function (s) {
          var con = {base_url: this.connection.base_url};
          this.connection.auth = FHEM_connectionAuth[this.connection.base_url];
          if (this.connection.auth) {
            con.auth = this.connection.auth;
          }
          batch.set(database.db.collection(database.getUid()).doc('devices').collection('devices').doc(s.Internals.NAME), {json: s, connection: con.base_url}, {merge: true});
        }.bind(this));
        await batch.commit();
        
        //call syncfinished
        await database.syncFinished();
        console.log(' ');
        console.log('-----------------------------------------------');
        console.log('   Ready! Open Home app and connect to FHEM.');
        console.log('-----------------------------------------------');
        console.log(' ');
      }

      if (callback)
          callback(this.devices);

    } else {
        this.log.error('There was a problem connecting to FHEM');
        if (response)
            this.log.error('  ' + response.statusCode + ': ' + response.statusMessage);
    }
}

//KEEP
FHEM.prototype.checkAndSetGenericDeviceType = function () {
    this.log('Checking devices and attributes...');

    var cmd = '{AttrVal("global","userattr","")}';
    this.execute(cmd,
        function (result) {
            //if( result === undefined )
            //result = '';

            if (!result.match(/(^| )homebridgeMapping\b/)) {
                this.execute('{ addToAttrList( "homebridgeMapping:textField-long" ) }');
                this.log.info('homebridgeMapping attribute created.');
            }

            if (!result.match(/(^| )realRoom\b/)) {
                this.execute('{ addToAttrList( "realRoom:textField" ) }');
                this.log.info('realRoom attribute created.');
            }

            if (!result.match(/(^| )ghomeName\b/)) {
                this.execute('{ addToAttrList( "ghomeName:textField" ) }');
                this.log.info('ghomeName attribute created.');
            }

            if (!result.match(/(^| )assistantName\b/)) {
                this.execute('{ addToAttrList( "assistantName:textField" ) }');
                this.log.info('assistantName attribute created.');
            }

            if (!result.match(/(^| )genericDeviceType:security,ignore,switch,outlet,light,blind,thermometer,thermostat,contact,garage,window,lock,aircondition,airpurifier,camera,coffeemaker,dishwasher,dryer,fan,kettle,oven,refrigerator,scene,sprinkler,vacuum,washer\b/)) {
                let m;
                if (m = result.match(/(^| )genericDeviceType(\S*)/)) {
                    this.execute('{ delFromAttrList( "genericDeviceType' + m[2] + '") }');
                }
                var cmd = '{addToAttrList( "genericDeviceType:security,ignore,switch,outlet,light,blind,thermometer,thermostat,contact,garage,window,lock,aircondition,airpurifier,camera,coffeemaker,dishwasher,dryer,fan,kettle,oven,refrigerator,scene,sprinkler,vacuum,washer" ) }';
                this.execute(cmd,
                    function (result) {
                        this.log.warn('genericDeviceType attribute was not known. please restart.');
                        process.exit(0);
                    }.bind(this));
            }

        }.bind(this));
};

//KEEP
function
FHEM_execute(connection, cmd, callback) {
    console.log('starting FHEM_execute');
    if (FHEM_csrfToken[connection.base_url])
        cmd += '&fwcsrf=' + FHEM_csrfToken[connection.base_url];
    cmd += '&XHR=1';
    var url = encodeURI(connection.base_url + '?cmd=' + cmd);
    console.log('  executing: ' + url);
    
    connection.auth = FHEM_connectionAuth[connection.base_url];
    var request = require('request');
    request = request.defaults({auth: connection.auth, rejectUnauthorized: false});

    request
        .get({url: url, gzip: true},
            function (err, response, result) {
                if (!err && response.statusCode == 200) {
                    result = result.replace(/[\r\n]/g, '');
                    if (callback)
                        callback(result);

                } else {
                    console.log('There was a problem connecting to FHEM (' + url + ').');
                    if (response)
                        console.log('  ' + response.statusCode + ': ' + response.statusMessage);

                }

            })
        .on('error', function (err) {
            console.error('There was a problem connecting to FHEM (' + url + '):' + err);
        });
};
