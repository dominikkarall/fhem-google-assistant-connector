const crypto = require('crypto');
const fetch = require('node-fetch');
const firebase = require('firebase/app');
require('firebase/auth');
require('firebase/firestore');
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
var uid = 'nouid';

var access_token = undefined;

exports.db = db;
exports.getUid = function() {
  return uid;
};

const CODE_REDIRECT_URI = CLOUD_FUNCTIONS_BASE + "/codelanding/start";
const FB_CUSTOM_TOKEN_URI = CLOUD_FUNCTIONS_BASE + "/firebase/token";
const REPORT_STATE_ALL = CLOUD_FUNCTIONS_BASE + "/api/reportstateall";
const SYNC_FINISHED = CLOUD_FUNCTIONS_BASE + "/api/syncfinished";
const UPDATE_INFORMID = CLOUD_FUNCTIONS_BASE + "/api/updateinformid";

exports.requestReportStateAll = function() {
  //console.log('requestReportStateAll: ' + access_token);
  fetch(REPORT_STATE_ALL, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });
};

exports.updateInformId = function(informId, val) {
  console.log('updateInformId: ' + informId);
  fetch(UPDATE_INFORMID, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    },
    body: JSON.stringify({informId: informId, value: val})
  });
};

exports.syncFinished = async function() {
  await fetch(SYNC_FINISHED, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });
};

exports.sendToFirestore = async function(msg, id) {
  await db.collection(uid).doc('msgs').collection('fhem2firestore').add({msg: msg, id: id});
}

exports.getInformId = async function(informId) {
  var doc = await db.collection(uid).doc('devices').collection('informids').doc(informId).get();
  return doc.data().value;
};

exports.setInformId = function(informId, val) {
  db.collection(uid).doc('devices').collection('informids').doc(informId).set({value: val});
};

exports.setDeviceAttribute = function(device, attr, val) {
  db.collection(uid).doc('devices').collection('devices').doc(device).set({[attr]: val}, {merge: true});
};

exports.getDeviceAttribute = async function(device, attr) {
  var doc = await db.collection(uid).doc('devices').collection('devices').doc(device).get();
  return doc.data()[attr];
};

function readTokenFile() {
  try {
    //read uid, access_token, firebase_token from file
    var tokens = fs.readFileSync('token', 'utf-8');
    tokens = JSON.parse(tokens);
    return {uid: tokens.uid, access: tokens.access, refresh: tokens.refresh, firebase: tokens.firebase};
  } catch (err) {
    console.log('no token files found');
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
    
    console.log(AUTH0_DOMAIN + "/authorize?audience=" + AUDIENCE_URI + "&scope=openid%20profile%20offline_access&response_type=code&client_id=" + CLIENT_ID + "&code_challenge=" + challenge + "&code_challenge_method=S256&redirect_uri=" + CODE_REDIRECT_URI);
    
    //request code from user
    const readline = require('readline-sync');
  
    var auth_code = readline.question('Please enter the authorization code here: ');
  
    //send POST to request a token
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
  var all_tokens = readTokenFile();
  if (all_tokens) {
    firebase_token = all_tokens.firebase;
    uid = all_tokens.uid;
  }
  
  do {
    if (!all_tokens && !signinRes) {
      //no token file => login
      auth0_tokens = await initiateAuth0Login();
      firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
    } else if (all_tokens && !signinRes) {
      //signin failed with access_token => get new with refresh_token
      auth0_tokens = await refreshToken(all_tokens.refresh);
      all_tokens = 0;
      firebase_token = await createFirebaseCustomToken(auth0_tokens.access);
    }
    access_token = auth0_tokens.access;
    
    try {
      signinRes = await firebase.auth().signInWithCustomToken(firebase_token.firebase);
    } catch(err) {
      console.log('sign in with token failed: ' + err);
      signinRes = 0;
    }
  } while(!signinRes);

  uid = firebase_token.uid;
  //save tokens to file
  if (!all_tokens && auth0_tokens.refresh)
    saveTokens(auth0_tokens.access, auth0_tokens.id, auth0_tokens.refresh, firebase_token.firebase, firebase_token.uid);
  console.log('Firestore login succeed!');
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
  const response = await fetch(FB_CUSTOM_TOKEN_URI, {
    headers: {
      'Authorization': 'Bearer ' + access_token,
      'content-type': 'application/json'
    }
  });
  
  //{firebase_token: token, uid: uid}
  var token = await response.json();
  //console.log('fb: ' + JSON.stringify(token));
  return {uid: token.uid, firebase: token.firebase_token};
}
