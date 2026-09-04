const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const admin = require('firebase-admin');
const { defineSecret } = require('firebase-functions/params');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2/options');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });
const db = admin.firestore();
const { FieldValue } = admin.firestore;
const TIME_ZONE = 'Asia/Kolkata';
const ADMIN_EMAIL = 'skphostel21@gmail.com';
const ADMIN_ACCESS_PASSWORD = defineSecret('ADMIN_ACCESS_PASSWORD');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const REPORT_SECRETS = [RESEND_API_KEY, EMAIL_FROM];

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication is required.');
  return request.auth;
}

function assertAdmin(request) {
  const auth = requireAuth(request);
  const email = String(auth.token.email || '').trim().toLowerCase();
  if (auth.token.admin !== true || email !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', 'Admin authorization is required.');
  }
  return auth;
}

function businessParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
}

function dateKey(date = new Date()) {
  const parts = businessParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function minutesInBusinessDay(date = new Date()) {
  const parts = businessParts(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function validateDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time))) {
    throw new HttpsError('invalid-argument', 'A valid date and time are required.');
  }
  const parsed = new Date(`${date}T${time}:00+05:30`);
  if (Number.isNaN(parsed.getTime())) throw new HttpsError('invalid-argument', 'Invalid date or time.');
  return parsed;
}

async function studentForUid(uid) {
  const byId = await db.collection('students').doc(uid).get();
  if (byId.exists) return { id: byId.id, data: byId.data() };
  const result = await db.collection('students').where('auth_uid', '==', uid).limit(1).get();
  return result.empty ? null : { id: result.docs[0].id, data: result.docs[0].data() };
}

function studentIdFromProfile(profile) {
  return String(profile.student_id || profile.id || '').trim();
}

function audit(action, auth, targetType, targetId, metadata = {}) {
  return db.collection('audit_logs').add({
    action, admin_id: auth.uid, target_type: targetType, target_id: targetId,
    metadata, timestamp: FieldValue.serverTimestamp()
  });
}

exports.getBusinessNow = onCall(async () => ({ now: new Date().toISOString(), timeZone: TIME_ZONE }));

exports.verifyAdminAccessPassword = onCall({ secrets: [ADMIN_ACCESS_PASSWORD] }, async (request) => {
  const ip = request.rawRequest && request.rawRequest.ip ? request.rawRequest.ip : 'unknown';
  const key = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const rateRef = db.collection('system_settings').doc(`admin_password_rate_${key}`);
  const now = Date.now();
  const allowed = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(rateRef);
    const current = snapshot.exists ? snapshot.data() : {};
    if (current.reset_at && current.reset_at > now && Number(current.attempts || 0) >= 10) return false;
    const resetAt = current.reset_at && current.reset_at > now ? current.reset_at : now + 15 * 60 * 1000;
    tx.set(rateRef, { attempts: Number(current.attempts || 0) + 1, reset_at: resetAt }, { merge: true });
    return true;
  });
  if (!allowed) throw new HttpsError('resource-exhausted', 'Too many password attempts. Please try again in 15 minutes.');
  const submitted = typeof request.data?.password === 'string' ? request.data.password : '';
  let expected = '';
  try {
    expected = ADMIN_ACCESS_PASSWORD.value() || '';
  } catch (err) {
    // Secret not configured in environment
  }
  if (!expected) {
    throw new HttpsError('failed-precondition', 'Admin access password is not configured on the server.');
  }
  const submittedBuffer = Buffer.from(submitted);
  const expectedBuffer = Buffer.from(expected);
  const matches = submittedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(submittedBuffer, expectedBuffer);
  if (!submitted.length || !matches) {
    throw new HttpsError('permission-denied', 'Incorrect admin access password.');
  }
  return { authorized: true };
});

exports.createPassRequest = onCall(async (request) => {
  const auth = requireAuth(request);
  const profileRecord = await studentForUid(auth.uid);
  if (!profileRecord) throw new HttpsError('failed-precondition', 'Student profile not found.');
  const data = request.data || {};
  const outDate = String(data.out_date || '');
  const outTime = String(data.out_time || '');
  const returnDate = String(data.expected_return_date || '');
  const returnTime = String(data.expected_return_time || '');
  if (!String(data.reason || '').trim()) throw new HttpsError('invalid-argument', 'Reason is required.');
  if (validateDateTime(outDate, outTime) >= validateDateTime(returnDate, returnTime)) {
    throw new HttpsError('invalid-argument', 'Expected return must be after departure.');
  }
  const profile = profileRecord.data;
  const studentId = studentIdFromProfile(profile);
  const doc = {
    student_uid: auth.uid, student_id: studentId,
    student_name: String(profile.student_name || profile.name || profile.full_name || ''),
    college: String(data.college || profile.college || ''),
    year: String(profile.year || profile.academic_year || data.year || ''),
    department: String(profile.department || profile.dept || ''),
    room_number: String(profile.room_number || profile.room || ''),
    phone_number: String(profile.phone_number || profile.phone || profile.mobile || ''),
    out_date: outDate, out_time: outTime, expected_return_date: returnDate,
    expected_return_time: returnTime, reason: String(data.reason).trim(),
    status: 'PENDING', outside_status: null,
    created_at: FieldValue.serverTimestamp(), reviewed_at: null, reviewed_by: null, returned_at: null
  };
  const ref = await db.collection('pass_requests').add(doc);
  await db.collection('audit_logs').add({ action: 'OUT_PASS_CREATED', admin_id: auth.uid, target_type: 'pass_request', target_id: ref.id, timestamp: FieldValue.serverTimestamp() });
  return { id: ref.id, student_id: studentId, status: 'PENDING', outside_status: null };
});

exports.adminMarkAttendance = onCall(async (request) => {
  const auth = assertAdmin(request);
  const studentId = String(request.data?.studentId || '').trim();
  const status = String(request.data?.status || '').toUpperCase();
  if (!studentId || !['PRESENT', 'ABSENT'].includes(status)) throw new HttpsError('invalid-argument', 'Invalid attendance input.');
  const now = new Date();
  const minutes = minutesInBusinessDay(now);
  if (minutes < 15 * 60 || minutes >= 16 * 60 + 30) throw new HttpsError('failed-precondition', 'Attendance is locked outside the 3:00 PM to 4:30 PM window.');
  const sessionId = dateKey(now);
  const sessionRef = db.collection('attendance_sessions').doc(sessionId);
  const attendanceRef = db.collection('attendance').doc(`${sessionId}_${studentId}`);
  await db.runTransaction(async (tx) => {
    const session = await tx.get(sessionRef);
    if (session.exists && session.data().status !== 'OPEN') throw new HttpsError('failed-precondition', 'Attendance session is locked.');
    if (!session.exists) tx.set(sessionRef, { session_date: sessionId, status: 'OPEN', timezone: TIME_ZONE, created_at: FieldValue.serverTimestamp(), opened_at: FieldValue.serverTimestamp() });
    tx.set(attendanceRef, { session_id: sessionId, student_id: studentId, status, marked_by: auth.uid, marked_at: FieldValue.serverTimestamp() }, { merge: true });
  });
  await audit('ATTENDANCE_MARKED', auth, 'attendance', attendanceRef.id, { student_id: studentId, status });
  return { session_id: sessionId, student_id: studentId, status };
});

exports.openAttendanceSession = onSchedule({ schedule: '0 15 * * *', timeZone: TIME_ZONE }, async () => {
  const id = dateKey();
  const ref = db.collection('attendance_sessions').doc(id);
  await ref.set({ session_date: id, status: 'OPEN', timezone: TIME_ZONE, created_at: FieldValue.serverTimestamp(), opened_at: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('audit_logs').add({ action: 'ATTENDANCE_SESSION_OPENED', admin_id: 'scheduler', target_type: 'attendance_session', target_id: id, timestamp: FieldValue.serverTimestamp() });
});

exports.lockAttendanceSession = onSchedule({ schedule: '30 16 * * *', timeZone: TIME_ZONE, secrets: REPORT_SECRETS }, async () => {
  const id = dateKey();
  await db.collection('attendance_sessions').doc(id).set({ status: 'LOCKED', locked_at: FieldValue.serverTimestamp() }, { merge: true });
  await generateAndSendReport(id);
});

exports.reviewOutPassRequest = onCall(async (request) => {
  const auth = assertAdmin(request);
  const id = String(request.data?.requestId || '');
  const decision = String(request.data?.decision || '').toUpperCase();
  if (!id || !['APPROVED', 'REJECTED'].includes(decision)) throw new HttpsError('invalid-argument', 'Invalid pass decision.');
  const ref = db.collection('pass_requests').doc(id);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.data().status !== 'PENDING') throw new HttpsError('failed-precondition', 'Pass is no longer pending.');
    tx.update(ref, { status: decision, outside_status: decision === 'APPROVED' ? 'OUTSIDE' : null, reviewed_by: auth.uid, reviewed_at: FieldValue.serverTimestamp(), approved_by: decision === 'APPROVED' ? auth.uid : null, approved_at: decision === 'APPROVED' ? FieldValue.serverTimestamp() : null });
  });
  await audit(decision === 'APPROVED' ? 'OUT_PASS_APPROVED' : 'OUT_PASS_REJECTED', auth, 'pass_request', id);
  return { id, status: decision };
});

exports.markPassReturned = onCall(async (request) => {
  const auth = requireAuth(request);
  const id = String(request.data?.requestId || request.data?.passId || '');
  if (!id) throw new HttpsError('invalid-argument', 'Pass ID is required.');
  const ref = db.collection('pass_requests').doc(id);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const pass = snapshot.data() || {};
    if (!snapshot.exists || pass.student_uid !== auth.uid || pass.status !== 'APPROVED' || pass.outside_status !== 'OUTSIDE') throw new HttpsError('permission-denied', 'Pass return is not authorized.');
    tx.update(ref, { outside_status: 'RETURNED', returned_at: FieldValue.serverTimestamp() });
  });
  await db.collection('audit_logs').add({ action: 'OUT_PASS_RETURNED', admin_id: auth.uid, target_type: 'pass_request', target_id: id, timestamp: FieldValue.serverTimestamp() });
  return { id, status: 'APPROVED', outside_status: 'RETURNED' };
});

exports.getApprovedPassForStudent = onCall(async (request) => {
  const auth = requireAuth(request);
  const id = String(request.data?.requestId || request.data?.passId || '');
  const snapshot = await db.collection('pass_requests').doc(id).get();
  const pass = snapshot.data() || {};
  if (!snapshot.exists || pass.student_uid !== auth.uid || pass.status !== 'APPROVED') throw new HttpsError('permission-denied', 'Approved pass is not available.');
  return { id: snapshot.id, ...pass };
});

exports.manageEmailRecipient = onCall(async (request) => {
  const auth = assertAdmin(request);
  const operation = String(request.data?.operation || '').toLowerCase();
  const id = String(request.data?.id || '');
  const email = String(request.data?.email || '').trim().toLowerCase();
  if (['add', 'update'].includes(operation) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError('invalid-argument', 'A valid email is required.');
  if (operation === 'delete') { await db.collection('email_recipients').doc(id).delete(); await audit('EMAIL_RECIPIENT_DELETED', auth, 'email_recipient', id); return { id, deleted: true }; }
  if (operation === 'add') {
    const duplicate = await db.collection('email_recipients').where('email', '==', email).limit(1).get();
    if (!duplicate.empty) throw new HttpsError('already-exists', 'Recipient already exists.');
    const ref = await db.collection('email_recipients').add({ email, enabled: request.data.enabled !== false, created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() });
    await audit('EMAIL_RECIPIENT_ADDED', auth, 'email_recipient', ref.id); return { id: ref.id, email };
  }
  if (operation === 'update') { await db.collection('email_recipients').doc(id).update({ email, enabled: Boolean(request.data.enabled), updated_at: FieldValue.serverTimestamp() }); await audit('EMAIL_RECIPIENT_UPDATED', auth, 'email_recipient', id); return { id, email }; }
  throw new HttpsError('invalid-argument', 'Unsupported recipient operation.');
});

async function buildReport(reportDate) {
  const studentsSnapshot = await db.collection('students').where('account_status', '==', 'ACTIVE').get();
  const attendanceSnapshot = await db.collection('attendance').where('session_id', '==', reportDate).get();
  const byStudent = new Map(attendanceSnapshot.docs.map((doc) => [String(doc.data().student_id), doc.data()]));
  const rows = studentsSnapshot.docs.map((doc) => {
    const student = doc.data();
    const id = studentIdFromProfile(student);
    return { Date: reportDate, 'Student ID': id, 'Student Name': student.name || student.student_name || '', College: student.college || '', Year: student.year || '', 'Phone Number': student.phone || student.phone_number || '', 'Room Number': student.room_number || student.room || '', 'Attendance Status': byStudent.get(id)?.status || 'NOT_MARKED' };
  });
  const counts = rows.reduce((result, row) => { result[row['Attendance Status'].toLowerCase()] = (result[row['Attendance Status'].toLowerCase()] || 0) + 1; return result; }, {});
  const total = rows.length;
  return { rows, total, present: counts.present || 0, absent: counts.absent || 0, not_marked: counts.not_marked || 0, percentage: total ? ((counts.present || 0) / total * 100).toFixed(2) : '0.00' };
}

async function makeExcel(rows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attendance');
  worksheet.columns = Object.keys(rows[0] || {}).map((header) => ({ header, key: header, width: Math.max(14, header.length + 2) }));
  worksheet.addRows(rows);
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F3A' } };
  return workbook.xlsx.writeBuffer();
}

function makeAbsentPdf(rows, reportDate) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fillColor('#0B1F3A').fontSize(18).text('APJ ABDUL KALAM BLOCK', { align: 'center' });
    doc.fillColor('#C9A227').fontSize(13).text(`Absent Students - ${reportDate}`, { align: 'center' });
    doc.moveDown();
    const absent = rows.filter((row) => row['Attendance Status'] === 'ABSENT');
    if (!absent.length) doc.fillColor('#111827').fontSize(12).text('No students are absent today.');
    absent.forEach((row) => doc.fillColor('#111827').fontSize(11).text(`${row['Student ID']} | ${row['Student Name']} | ${row['Phone Number']} | ${row.College} | ${row.Year} | ${row['Room Number']}`));
    doc.end();
  });
}

function makeOutPassPdf(pass) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fillColor('#0B1F3A').fontSize(18).text('APJ ABDUL KALAM BLOCK', { align: 'center' });
    doc.fillColor('#C9A227').fontSize(14).text('HOSTEL OUT PASS', { align: 'center' });
    doc.moveDown();
    doc.fillColor('#111827').fontSize(10);
    [['Out Pass ID', pass.id], ['Student Name', pass.student_name], ['Student ID', pass.student_id], ['College', pass.college], ['Year', pass.year], ['Department', pass.department], ['Room Number', pass.room_number], ['Phone Number', pass.phone_number], ['Out Date', pass.out_date], ['Out Time', pass.out_time], ['Expected Return Date', pass.expected_return_date], ['Expected Return Time', pass.expected_return_time], ['Reason', pass.reason], ['Status', 'APPROVED'], ['Approved By', pass.approved_by], ['Approval Date/Time', pass.approved_at], ['Warden Approval', 'APPROVED']].forEach(([label, value]) => doc.text(`${label}: ${value || ''}`));
    doc.end();
  });
}

async function generateAndSendReport(reportDate) {
  const reportRef = db.collection('daily_reports').doc(reportDate);
  const existing = await reportRef.get();
  if (existing.exists && existing.data().email_status === 'SENT') return existing.data();
  const report = await buildReport(reportDate);
  const excel = await makeExcel(report.rows);
  const pdf = await makeAbsentPdf(report.rows, reportDate);
  const recipientsSnapshot = await db.collection('email_recipients').where('enabled', '==', true).get();
  const recipients = recipientsSnapshot.docs.map((doc) => doc.data().email).filter(Boolean);
  const base = { report_date: reportDate, report_time: '4:30 PM', total_students: report.total, present: report.present, absent: report.absent, not_marked: report.not_marked, attendance_percentage: Number(report.percentage), idempotency_key: `attendance_report_${reportDate}`, generated_at: FieldValue.serverTimestamp() };
  await reportRef.set({ ...base, email_status: 'PENDING' }, { merge: true });
  if (!recipients.length) { await reportRef.update({ email_status: 'FAILED', error: 'No enabled recipients.' }); throw new Error('No enabled recipients.'); }
  try {
    if (!RESEND_API_KEY.value() || !EMAIL_FROM.value()) throw new Error('Email secrets are not configured.');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: EMAIL_FROM.value(), to: recipients, subject: `APJ ABDUL KALAM BLOCK Daily Attendance Report - ${reportDate}`, text: `Total Students: ${report.total}\nPresent: ${report.present}\nAbsent: ${report.absent}\nNot Marked: ${report.not_marked}\nAttendance Percentage: ${report.percentage}%`, attachments: [{ filename: `attendance_${reportDate}.xlsx`, content: Buffer.from(excel).toString('base64') }, { filename: `absent_${reportDate}.pdf`, content: pdf.toString('base64') }] }) });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
    await reportRef.update({ email_status: 'SENT', sent_at: FieldValue.serverTimestamp(), error: FieldValue.delete() });
    await db.collection('audit_logs').add({ action: 'DAILY_REPORT_SENT', admin_id: 'scheduler', target_type: 'daily_report', target_id: reportDate, timestamp: FieldValue.serverTimestamp() });
    return { ...base, email_status: 'SENT' };
  } catch (error) {
    await reportRef.update({ email_status: 'FAILED', error: 'Report delivery failed.' });
    throw error;
  }
}

exports.sendDailyAttendanceReport = onCall({ secrets: REPORT_SECRETS }, async (request) => { const auth = assertAdmin(request); const result = await generateAndSendReport(String(request.data?.reportDate || dateKey())); await audit('DAILY_REPORT_SENT', auth, 'daily_report', result.report_date); return result; });
exports.generateDailyAttendanceReport = onCall(async (request) => { assertAdmin(request); const id = String(request.data?.reportDate || dateKey()); return buildReport(id); });
exports.generateOutPassPdf = onCall(async (request) => {
  const auth = requireAuth(request);
  const id = String(request.data?.requestId || request.data?.passId || '');
  const snapshot = await db.collection('pass_requests').doc(id).get();
  const pass = snapshot.data() || {};
  const email = String(auth.token.email || '').trim().toLowerCase();
  const isAdminUser = auth.token.admin === true && email === ADMIN_EMAIL;
  const isPassOwner = pass.student_uid === auth.uid;

  if (!snapshot.exists || pass.status !== 'APPROVED' || (!isPassOwner && !isAdminUser)) {
    throw new HttpsError('permission-denied', 'Approved pass is not available.');
  }
  const pdf = await makeOutPassPdf({ id: snapshot.id, ...pass });
  return { id: snapshot.id, filename: `APJ_Abdul_Kalam_Block_OutPass_${pass.student_id}_${snapshot.id}.pdf`, contentType: 'application/pdf', data: pdf.toString('base64') };
});
