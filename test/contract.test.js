const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');

const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const firebaseJsonSource = fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8');

test('1. firebase.json excludes Cloud Functions for Spark ₹0 plan', () => {
  assert.equal(firebaseJsonSource.includes('"functions"'), false, 'firebase.json still configures Cloud Functions!');
});

test('2. public/index.html has zero dead Cloud Function calls', () => {
  assert.equal(htmlSource.includes('httpsCallable'), false, 'public/index.html contains httpsCallable calls!');
  assert.equal(htmlSource.includes('firebaseFunctions'), false, 'public/index.html contains firebaseFunctions references!');
  assert.equal(htmlSource.includes('firebase.functions()'), false, 'public/index.html initializes firebase.functions()!');
  assert.equal(htmlSource.includes('onCall'), false, 'public/index.html contains onCall references!');
  assert.equal(htmlSource.includes('onRequest'), false, 'public/index.html contains onRequest references!');
});

test('3. zero hardcoded passwords or secrets in codebase', () => {
  assert.equal(htmlSource.includes('Skphostel@1234'), false, 'public/index.html contains hardcoded password!');
  assert.equal(htmlSource.includes('RESEND_API_KEY'), false, 'public/index.html contains RESEND_API_KEY!');
  assert.equal(htmlSource.includes('ADMIN_ACCESS_PASSWORD'), false, 'public/index.html contains ADMIN_ACCESS_PASSWORD!');
});

test('4. student authentication uses persistence.LOCAL and onAuthStateChanged', () => {
  assert.match(htmlSource, /setPersistence\(firebase\.auth\.Auth\.Persistence\.LOCAL\)/);
  assert.match(htmlSource, /signInWithEmailAndPassword/);
  assert.match(htmlSource, /onAuthStateChanged/);
});

test('5. admin authorization restricts strictly to skphostel21@gmail.com', () => {
  assert.match(htmlSource, /skphostel21@gmail\.com/);
  assert.match(htmlSource, /Access Failed/);
  assert.match(rulesSource, /request\.auth\.token\.email\.lower\(\) == 'skphostel21@gmail\.com'/);
});

test('6. firestore.rules enforces deny-by-default, student isolation and client CRUD permissions', () => {
  assert.match(rulesSource, /match \/students\/\{uid\}[\s\S]*request\.auth\.uid == uid \|\| resource\.data\.auth_uid == request\.auth\.uid/);
  assert.match(rulesSource, /match \/pass_requests\/\{passId\}[\s\S]*request\.resource\.data\.status == 'PENDING'/);
  assert.match(rulesSource, /match \/attendance\/\{attendanceId\}[\s\S]*allow create, update, delete: if isAdmin\(\);/);
  assert.match(rulesSource, /match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/);
});

test('7. out pass state machine and student write restrictions are enforced', () => {
  assert.match(rulesSource, /request\.resource\.data\.status == 'PENDING'/);
  assert.match(htmlSource, /status === "APPROVED"/);
  assert.match(htmlSource, /outside_status: "RETURNED"/);
});

test('8. client-side PDF and Excel export libraries are present and used', () => {
  assert.match(htmlSource, /xlsx\.full\.min\.js/);
  assert.match(htmlSource, /jspdf\.umd\.min\.js/);
  assert.match(htmlSource, /window\.jspdf\.jsPDF/);
});

test('9. attendance window specifies Asia/Kolkata 3:00 PM to 4:30 PM IST', () => {
  assert.match(htmlSource, /Asia\/Kolkata/);
  assert.match(htmlSource, /3:00 PM/);
  assert.match(htmlSource, /4:30 PM/);
});

test('10. firestore queries use limit pagination to prevent unbounded reads', () => {
  assert.match(htmlSource, /\.limit\(20\)/);
  assert.match(htmlSource, /\.limit\(200\)/);
});

test('11. PWA manifest and network-first service worker are configured', () => {
  const swSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'service-worker.js'), 'utf8');
  assert.match(swSource, /fetch\(request\)/);
  assert.match(swSource, /caches\.open/);
});

test('13. Admin Panel Student Management UI elements exist in index.html', () => {
  assert.match(htmlSource, /id="btn-open-add-student"/);
  assert.match(htmlSource, /id="admin-student-table-body"/);
  assert.match(htmlSource, /id="modal-student-form"/);
  assert.match(htmlSource, /id="modal-reset-password"/);
  assert.match(htmlSource, /id="modal-delete-student"/);
  assert.match(htmlSource, /filter-student-search/);
});

test('14. Student account creation uses secondary temp Firebase App to preserve Admin session', () => {
  assert.match(htmlSource, /createStudentAuthAccount/);
  assert.match(htmlSource, /firebase\.initializeApp\(firebaseConfig, tempAppName\)/);
  assert.match(htmlSource, /tempAuth\.createUserWithEmailAndPassword/);
  assert.match(htmlSource, /Student ID already exists/);
});

test('15. Student login uses Student ID, blocks disabled accounts, and excludes self-registration', () => {
  assert.match(htmlSource, /Your account has been disabled\. Please contact the administrator\./);
  assert.match(htmlSource, /Invalid Student ID or Password\./);
  assert.equal(htmlSource.includes('register-form'), false, 'Public registration form must not exist!');
  assert.equal(htmlSource.includes('Create Account'), false, 'Public Create Account link must not exist!');
});

test('16. Performance optimizations: Promise.all parallel data loading, debounced search, visibility polling, and admin student stat counters', () => {
  assert.match(htmlSource, /Promise\.all\(\[loadAdminPasses\(\),\s*loadAdminStudents\(\)/);
  assert.match(htmlSource, /debounce/);
  assert.match(htmlSource, /document\.hidden/);
  assert.match(htmlSource, /id="stat-total-students"/);
  assert.match(htmlSource, /id="stat-active-students"/);
  assert.match(htmlSource, /id="stat-disabled-students"/);
});

test('17. Professional Attendance Reporting System: single-worksheet Excel, absent-only PDF, report history, and security rules', () => {
  assert.match(rulesSource, /match \/attendance_reports\/\{reportId\}[\s\S]*allow read, write: if isAdmin\(\);/);
  assert.match(htmlSource, /id="card-admin-attendance-reports"/);
  assert.match(htmlSource, /id="report-filter-date"/);
  assert.match(htmlSource, /id="report-filter-dept"/);
  assert.match(htmlSource, /id="report-filter-year"/);
  assert.match(htmlSource, /id="report-filter-room"/);
  assert.match(htmlSource, /id="report-filter-session"/);
  assert.match(htmlSource, /id="btn-generate-excel-report"/);
  assert.match(htmlSource, /id="btn-generate-pdf-report"/);
  assert.match(htmlSource, /id="report-history-table-body"/);
  assert.match(htmlSource, /PRESENT STUDENTS/);
  assert.match(htmlSource, /ABSENT STUDENTS/);
});

test('18. Firestore uses named database apj-hostel-db in index.html and firebase.json', () => {
  assert.match(firebaseJsonSource, /"database":\s*"apj-hostel-db"/);
  assert.match(htmlSource, /firebase\.app\(\)\.firestore\("apj-hostel-db"\)/);
});


