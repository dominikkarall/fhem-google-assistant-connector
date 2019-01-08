const crypto = require('crypto');
const fetch = require('node-fetch');
const firebase = require('firebase/app');
require('firebase/auth');
require('firebase/firestore');
require('firebase/database');
const fs = require('fs');
const settings = require('./settings.json');

const CLOUD_FUNCTIONS_BASE = settings.CLOUD_FUNCTIONS_BASE;
const AUDIENCE_URI = settings.AUDIENCE_URI;
const CLIENT_ID = settings.CLIENT_ID;
const AUTH0_DOMAIN = settings.AUTH0_DOMAIN;

var fbApp = firebase.initializeApp(settings.firebase);

var db = firebase.firestore();
const settingsfs = {timestampsInSnapshots: true};
db.settings(settingsfs);

var all_tokens = {};
var heartbeat;
var realdb = firebase.database();

exports.db = db;
exports.realdb = realdb;
exports.getUid = function() {
  return all_tokens.uid;
};

const CODE_REDIRECT_URI = CLOUD_FUNCTIONS_BASE + "/codelanding/start";
const FB_CUSTOM_TOKEN_URI = CLOUD_FUNCTIONS_BASE + "/firebase/token";
const REPORT_STATE_ALL = CLOUD_FUNCTIONS_BASE + "/api/reportstateall";
const SYNC_FINISHED = CLOUD_FUNCTIONS_BASE + "/api/syncfinished";
const UPDATE_INFORMID = CLOUD_FUNCTIONS_BASE + "/api/updateinformid";
const INIT_SYNC = CLOUD_FUNCTIONS_BASE + "/api/initsync";
const DELETE_USER_ACCOUNT = CLOUD_FUNCTIONS_BASE + "/api/deleteuseraccount";

exports.deleteUserAccount = async function deleteUserAccount() {
  var res = await fetch(DELETE_USER_ACCOUNT, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(DELETE_USER_ACCOUNT, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
}

exports.clientHeartbeat = async function clientHeartbeat() {
  await realdb.ref('users/' + all_tokens.uid + '/heartbeat').set({active: 1, time: Date.now()});
  heartbeat = setTimeout(clientHeartbeat, 5000);
  return;
}

exports.clientShutdown = function () {
  clearTimeout(heartbeat);
  realdb.ref('users/' + all_tokens.uid + '/heartbeat').set({active: 0, time: Date.now()});
  return;
}

exports.requestReportStateAll = async function() {
  var res = await fetch(REPORT_STATE_ALL, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(REPORT_STATE_ALL, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
};

exports.updateInformId = function(informId, device, val) {
  //realdb.ref('users/' + all_tokens.uid + '/informids/' + informId + '/').set({value: val, device: device});
  
  var res = fetch(UPDATE_INFORMID, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    },
    body: JSON.stringify({informId: informId, value: val, device: device})
  })
  .then(async res => {
    if (res.status == 401) {
      await refreshAllTokens();
      fetch(UPDATE_INFORMID, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + all_tokens.access,
          'content-type': 'application/json'
        },
        body: JSON.stringify({informId: informId, value: val, device: device})
      });
    }
  });
};

exports.initiateSync = async function() {
  var res = await fetch(INIT_SYNC, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });
  
  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(INIT_SYNC, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
  console.log('SYNC initiated');
}

exports.syncFinished = async function() {
  var res = await fetch(SYNC_FINISHED, {
    headers: {
      'Authorization': 'Bearer ' + all_tokens.access,
      'content-type': 'application/json'
    }
  });

  if (res.status == 401) {
    await refreshAllTokens();
    await fetch(SYNC_FINISHED, {
      headers: {
        'Authorization': 'Bearer ' + all_tokens.access,
        'content-type': 'application/json'
      }
    });
  }
};

exports.reportClientVersion = async function() {
  await db.collection(all_tokens.uid).doc('client').set({version: settings.CLIENT_VERSION}, {merge: true});
}

exports.sendToFirestore = async function(msg, id) {
  await db.collection(all_tokens.uid).doc('msgs').collection('fhem2firestore').add({msg: msg, id: id});
}

// exports.getInformId = async function(informId) {
//   var doc = await db.collection(all_tokens.uid).doc('devices').collection('informids').doc(informId).get();
//   return doc.data().value;
// };

// exports.setInformId = function(informId, val) {
//   db.collection(all_tokens.uid).doc('devices').collection('informids').doc(informId).set({value: val});
// };

exports.setDeviceAttribute = function(device, attr, val) {
  db.collection(all_tokens.uid).doc('devices').collection('devices').doc(device).set({[attr]: val}, {merge: true});
};

exports.getDeviceAttribute = async function(device, attr) {
  var doc = await db.collection(all_tokens.uid).doc('devices').collection('devices').doc(device).get();
  return doc.data()[attr];
};

function readTokenFile() {
  try {
    //read uid, access_token, firebase_token from file
    var tokens = fs.readFileSync('token', 'utf-8');
    tokens = JSON.parse(tokens);
    return {uid: tokens.uid, access: tokens.access, refresh: tokens.refresh, firebase: tokens.firebase};
  } catch (err) {
    console.log('Token file not found, starting login procedure...');
    return undefined;
  }
}

//create verifier
function base64URLEncode(str) {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

//create challenge
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

async function initiateAuth0Login() {
    var verifier = base64URLEncode(crypto.randomBytes(32));
    var challenge = base64URLEncode(sha256(verifier));
    
    console.log(' ');
    console.log('Please open the following link in your browser:');
    console.log(AUTH0_DOMAIN + "/authorize?audience=" + AUDIENCE_URI + "&scope=openid%20profile%20offline_access&response_type=code&client_id=" + CLIENT_ID + "&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=" + CODE_REDIRECT_URI);
    console.log(' ');
    
    //request code from user
    const readline = require('readline-sync');
  
    var auth_code = readline.question('Please enter the authorization code here: ');
  
    //send POST to request a token
    //TODO set state and verify state on codelanding page
    var options = { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"grant_type":"authorization_code","client_id":"' + CLIENT_ID + '","code_verifier":"' + verifier + '","code": "' + auth_code + '","redirect_uri": "' + CODE_REDIRECT_URI + '"}' };
    const response = await fetch(AUTH0_DOMAIN + '/oauth/token', options);
    var tokens = await response.json();
    return {access: tokens.access_token, id: tokens.id_token, refresh: tokens.refresh_token};
}

exports.login = async function() {

  var firebase_token;
  var signinRes = 0;
  var auth0_tokens;
  
  //read from file
  all_tokens = readTokenFile();
  
  do {
    if (!(all_tokens && all_tokens.refresh) && !signinRes) {
      //no token file => login
      auth0_tokens = await initiateAuth0Login();
      firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
      all_tokens = {access: auth0_tokens.access, id: auth0_tokens.id, refresh: auth0_tokens.refresh, firebase: firebase_token.firebase, uid: firebase_token.uid};
    } else if (all_tokens && all_tokens.refresh && !signinRes) {
      //signin failed with access_token => get new with refresh_token
      console.log('Refreshing tokens...');
      await refreshAllTokens();
    }
    
    try {
      signinRes = await firebase.auth().signInWithCustomToken(all_tokens.firebase);
      if (signinRes.status == 401)
        await refreshAllTokens();
    } catch(err) {
      console.log('sign in with token failed: ' + err);
      signinRes = 0;
    }
  } while(!signinRes);

  //save tokens to file
  saveTokens(all_tokens.access, all_tokens.id, all_tokens.refresh, all_tokens.firebase, all_tokens.uid);

  console.log('Firestore login succeed!');
}

async function refreshAllTokens() {
  if (!all_tokens.refresh) {
    console.error('No refresh token found.');
    console.error('Delete the token file and start the process again');
    process.exit(1);
  }

  auth0_tokens = await refreshToken(all_tokens.refresh);
  firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
  
  all_tokens = {access: auth0_tokens.access, id: auth0_tokens.id, refresh: all_tokens.refresh, firebase: firebase_token.firebase, uid: firebase_token.uid};
  saveTokens(auth0_tokens.access, auth0_tokens.id, all_tokens.refresh, firebase_token.firebase, firebase_token.uid);
  return;
}

function saveTokens(access_token, id_token, refresh_token, firebase_token, uid) {
    fs.writeFile('token', JSON.stringify({uid: uid, access: access_token, refresh: refresh_token, firebase: firebase_token}), (error) => {});
}

async function refreshToken(refresh_token) {
  //send POST to request a token
  var options = { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"grant_type":"refresh_token","client_id":"' + CLIENT_ID + '","refresh_token":"' + refresh_token + '"}' };

  const response = await fetch(AUTH0_DOMAIN + '/oauth/token', options);
  var tokens = await response.json();
  var access_token = tokens.access_token;
  var id_token = tokens.id_token;
  var refresh_token = tokens.refresh_token;
  
  return {access: access_token, id: id_token, refresh: refresh_token};
}

async function createFirebaseCustomToken(access_token) {
  //console.log('access_token: ' + access_token);
  var response = await fetch(FB_CUSTOM_TOKEN_URI, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });
  
  if (response.status == 401) {
    await refreshAllTokens();
    response = await fetch(FB_CUSTOM_TOKEN_URI, {
      headers: {
        'Authorization': 'Bearer ' + access_token,
        'content-type': 'application/json'
      }
    });
  }
  
  //{firebase_token: token, uid: uid}
  var token = await response.json();
  //console.log('fb: ' + JSON.stringify(token));
  return {uid: token.uid, firebase: token.firebase_token};
}
