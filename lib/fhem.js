'use strict';

var util = require('util');
var version = require('./version');
var database = require('./database');

module.exports = {
    FHEM: FHEM,
    FHEM_execute: FHEM_execute,
    FHEM_registerSyncFinishedListener: registerSyncFinishedListener
};

var FHEM_usedDevices = {};
var FHEM_longpoll = {};
var FHEM_csrfToken = {};
var FHEM_informids = {};

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
    this.connection.auth = auth;

    FHEM_startLongpoll(this.connection);
}

var tzoffset = (new Date()).getTimezoneOffset() * 60000; //offset in milliseconds

//KEEP
function
FHEM_update(informId, orig) {
    if (orig === undefined)
        return;

    //retrieve informids once
    database.db.collection(database.getUid()).doc('devices').collection('informids').doc(informId).update({value: orig}).then(res => {
      var date = new Date(Date.now() - tzoffset).toISOString().replace(/T/, ' ').replace(/\..+/, '');
      console.log('  ' + date + ' caching: ' + informId + ': ' + orig);
    })
    .catch(err => {
      console.error('  ' + date + ' ERROR caching: ' + informId + ': ' + orig);
    });
}

function registerSyncFinishedListener() {
  database.db.collection(database.getUid()).doc('state').onSnapshot(async (docSnapshot) => {
    console.log('SYNC UPDATED RECEIVED: ' + JSON.stringify(docSnapshot.data()));
    if (docSnapshot.data() && docSnapshot.data().syncactive == '0' && docSnapshot.data().disconnected == '0') {
      setInformIdsFromFirestore();
    } else {
      FHEM_informids = {};
    }
  });
}

function setInformIdsFromFirestore() {
  //retrieve informids
  database.db.collection(database.getUid()).doc('devices').collection('informids').get()
    .then(refs => {
      refs.forEach(ref => {
          FHEM_informids[ref.id] = 1;
          console.log('handling informid: ' + ref.id);
      });
    });
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
    if (connection.auth)
      request = request.defaults({auth: connection.auth, rejectUnauthorized: false});
    request.get({url: url}).on('data', function (data) {
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
//console.log(d);

                if (d[0].match(/-ts$/))
                    continue;
                if (d[0].match(/^#FHEMWEB:/))
                    continue;

                var match = d[0].match(/([^-]*)-(.*)/);
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
                if (FHEM_usedDevices[device] && FHEM_informids[d[0]]) {
                  FHEM_update(d[0], value);
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

    this.log.info('Fetching FHEM devices...');

    this.devices = [];

    if (FHEM_csrfToken[this.connection.base_url] === undefined) {
        setTimeout(function () {
            this.connection.fhem.connect(callback, filter);
        }.bind(this), 500);
        return;
    }

    let cmd = 'jsonlist2';
    if (filter)
        cmd += ' ' + filter;
    if (FHEM_csrfToken[this.connection.base_url])
        cmd += '&fwcsrf=' + FHEM_csrfToken[this.connection.base_url];
    const url = encodeURI(this.connection.base_url + '?cmd=' + cmd + '&XHR=1');
    this.log.info('fetching: ' + url);

    var request = require('request-promise');
    if (this.connection.auth)
      request = request.defaults({auth: this.connection.auth, rejectUnauthorized: false});
      
    var response = await request({url: url, json: true, gzip: true, resolveWithFullResponse: true});
    if (response.statusCode === 200) {
      var json = response.body;
      // console.log("got json: " + util.inspect(json));
      this.log.info('got: ' + json['totalResultsReturned'] + ' results');
      FHEM_usedDevices = {};
      if (json['totalResultsReturned']) {
        var batch = database.db.batch();
        
        //DELETE current data in database
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('devices').get();
          for (var r of ref.docs) {
            batch.delete(r);
          }
        } catch (err) {
          console.error('Device deletion failed: ' + err);
        }
        
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('attributes').get();
          for (var r of ref.docs) {
            batch.delete(r);
          }
        } catch (err) {
          console.error('Device deletion failed: ' + err);
        }
        
        try {
          var ref = await database.db.collection(database.getUid()).doc('devices').collection('informids').get();
          for (var r of ref.docs) {
            batch.delete(r);
          }
          } catch (err) {
          console.error('Device deletion failed: ' + err);
        }
    
        json['Results'].map(function (s) {
          var con = {base_url: this.connection.base_url};
          if (this.connection.auth) {
            con.auth = this.connection.auth;
          }
          FHEM_usedDevices[s.Internals.NAME] = 1;
          batch.set(database.db.collection(database.getUid()).doc('devices').collection('devices').doc(s.Internals.NAME), {json: s, connection: con}, {merge: true});
        }.bind(this));
        await batch.commit();
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
