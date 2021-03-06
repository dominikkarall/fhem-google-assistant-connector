'use strict';

const fs = require('fs');
const version = require('./version');
const User = require('./user').User;
const log = require("./logger")._system;
const Logger = require('./logger').Logger;
const FHEM = require('./fhem').FHEM;
const FHEM_execute = require('./fhem').FHEM_execute;
const FHEM_registerSyncFinishedListener = require('./fhem').FHEM_registerSyncFinishedListener;
const database = require('./database');

module.exports = {
    Server: Server
}

function Server() {
    this._config = this._loadConfig();
}

Server.prototype._loadConfig = function () {

    // Load up the configuration file
    let config;
    // Look for the configuration file
    const configPath = User.configPath();
    log.info("using " + configPath);
    
    // Complain and exit if it doesn't exist yet
    if (!fs.existsSync(configPath)) {
        log.error("Couldn't find config.json at " + configPath + ", using default values.");
        config =
          {
              "connections": [
                  {
                      "name": "FHEM",
                      "server": "127.0.0.1",
                      "port": "8083",
                      "webname": "fhem",
                      "filter": "room=GoogleAssistant"
                  }
              ]
          };
    } else {
      try {
          config = JSON.parse(fs.readFileSync(configPath));
      }
      catch (err) {
          log.error("There was a problem reading your config.json file.");
          log.error("Please try pasting your config.json file here to validate it: http://jsonlint.com");
          log.error("");
          throw err;
      }
    }

    log.info("---");
    log.info('config:\n' + JSON.stringify(config) + '\n');
    log.info("---");

    return config;
}

Server.prototype.startServer = function () {
    //TODO delete all docs in the collection to prevent using old data
    try {
      database.db.collection(database.getUid()).doc('msgs').collection('firestore2fhem').onSnapshot((events) => {
        events.forEach((event) => {
          console.log('GOOGLE MSG RECEIVED: ' + JSON.stringify(event.data()));
          if (event.data()) {
            handler.bind(this)(event.data());
          }
          event.ref.delete();
        });
      });
    } catch(err) {
      console.error('onSnapshot failed: ' + err);
    }
    
    FHEM_registerSyncFinishedListener();
}

Server.prototype.run = function () {
    log.info('Google Assistant FHEM Connect ' + version + ' started');

    if (!this._config.connections) {
        log.error('no connections in config file');
        process.exit(-1);
    }
    
    database.reportClientVersion();
    database.clientHeartbeat();

    this.startServer();

    this.roomOfIntent = {};

    log.info('Fetching FHEM connections...');

    this.devices = {};
    this.connections = [];
    for (var connection of this._config.connections) {
        var fhem = new FHEM(Logger.withPrefix(connection.name), connection);

        fhem.connect();

        this.connections.push(fhem);
    }
}

// entry
var handler = async function (event, callback) {
    if (!event.msg) {
        //something was deleted in firestore, no need to handle
        return;
    }
    
    log2("Received firestore2fhem", event);

    try {

        switch (event.msg) {

            case 'RELOAD_DEVICES':
                //reload all devices and SYNC afterwards
                for (var fhem of this.connections) {
                    //await fhem.reload();
                    setTimeout(await database.requestReportStateAll, 100000);
                }
                return;

            case 'EXECUTE':
                FHEM_execute({base_url: event.connection}, event.cmd);
                break;
                
            case 'UPDATE_CLIENT':
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                log2("ERROR", "!!!!!!!!PLEASE UPDATE YOUR CLIENT ASAP!!!!!!!!!!!");
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                log2("ERROR", "#################################################");
                break;
                
            case 'STOP_CLIENT':
                process.exit(1);
                break;

            default:
                log2("Error", "Unsupported namespace: " + requestedNamespace);

                //TODO response = handleUnexpectedInfo(requestedNamespace);

                break;

        }// switch

    } catch (error) {

        log2("Error", error);

    }// try-catch

    //return response;

}// exports.handler

var log2 = function (title, msg) {

    console.log('**** ' + title + ': ' + JSON.stringify(msg));

}// log
