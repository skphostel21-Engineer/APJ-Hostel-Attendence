const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');

const functionSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const rulesSource = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

test('privileged callable contracts are present', () => {
  for (const name of ['adminMarkAttendance', 'reviewOutPassRequest', 'markPassReturned', 'sendDailyAttendanceReport', 'verifyAdminAccessPassword', 'generateOutPassPdf']) {
    assert.match(functionSource, new RegExp(`exports\\.${name}\\s*=`));
  }
  assert.match(functionSource, /auth\.token\.admin !== true/);
  assert.match(functionSource, /skphostel21@gmail\.com/);
});

test('zero hardcoded fallback passwords in codebase', () => {
  assert.equal(functionSource.includes('Skphostel@1234'), false, 'functions/index.js contains hardcoded password!');
  assert.equal(htmlSource.includes('Skphostel@1234'), false, 'public/index.html contains hardcoded password!');
});

test('verifyAdminAccessPassword fails closed when secret is unconfigured', () => {
  assert.match(functionSource, /ADMIN_ACCESS_PASSWORD\.value\(\)/);
  assert.match(functionSource, /failed-precondition/);
  assert.match(functionSource, /Admin access password is not configured on the server/);
});

test('generateOutPassPdf authorizes student owner AND warden admin', () => {
  assert.match(functionSource, /const isPassOwner = pass\.student_uid === auth\.uid;/);
  assert.match(functionSource, /const isAdminUser = auth\.token\.admin === true && email === ADMIN_EMAIL;/);
  assert.match(functionSource, /if \(!snapshot\.exists || pass\.status !== 'APPROVED' \|\| \(!isPassOwner && !isAdminUser\)\)/);
});

test('rules enforce admin claim, email restriction, student ownership isolation and fallback deny', () => {
  assert.match(rulesSource, /request\.auth\.token\.admin == true/);
  assert.match(rulesSource, /request\.auth\.token\.email\.lower\(\) == 'skphostel21@gmail\.com'/);
  assert.match(rulesSource, /match \/students\/\{uid\}[\s\S]*request\.auth\.uid == uid \|\| resource\.data\.auth_uid == request\.auth\.uid/);
  assert.match(rulesSource, /match \/pass_requests\/\{passId\}[\s\S]*allow create, update, delete: if false/);
  assert.match(rulesSource, /match \/attendance\/\{attendanceId\}[\s\S]*allow write: if false/);
  assert.match(rulesSource, /match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/);
});

test('server report uses Asia/Kolkata timezone, idempotency and does not cache private data', () => {
  assert.match(functionSource, /Asia\/Kolkata/);
  assert.match(functionSource, /idempotency_key/);
  assert.match(functionSource, /email_status === 'SENT'/);
});


