var program = require('commander');
var version = require('./version');
var Server = require('./server').Server;
var User = require('./user').User;
var log = require("./logger")._system;

var database = require('./database');

'use strict';

module.exports = function() {

  program
    .version(version)
    .option('-U, --user-storage-path [path]', 'look for ghome user files at [path] instead of the default location (~/.ghome)', function(p) { User.setStoragePath(p); })
    .option('-D, --debug', 'turn on debug level logging', function() { require('./logger').setDebugEnabled(true) })
    .parse(process.argv);
  
  async function dblogin() {
    await database.login();
  }
  dblogin()
    .then(function() {

      var server = new Server();
    
      var signals = { 'SIGINT': 2, 'SIGTERM': 15 };
      Object.keys(signals).forEach(function (signal) {
        process.on(signal, function () {
          log.info("Got %s, shutting down ghome-fhem...", signal);
          process.exit(128 + signals[signal]);
        });
      });
    
      server.run();
    });
}
