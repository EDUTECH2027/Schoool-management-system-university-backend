// Static, role-specific "how to use the application" knowledge base. It describes where things are in the menus and
// how the workflows behave; it contains NO school data. Keep it factual: the assistant must not invent features.
// Menu names are given in English; the assistant answers in the language the user writes in.

const COMMON = `
GENERAL
- The application is a university management system. Everyone signs in on the login page: staff and lecturers with their e-mail and password, students with their matricule (student ID), no password.
- Forgot your password? On the login page choose "Forgot password" and enter your e-mail. A request goes to the school administrator; once it is approved you return to the login page and create a new password yourself.
- A new password must be at least 8 characters, must not equal your e-mail or name, and must not be a very common password. After 5 failed sign-ins an account is locked for 15 minutes (an administrator can unlock it earlier).
- The language (English / Français) and light/dark mode can be changed from the header. Notifications appear under the bell / "Notifications" menu.
- The assistant (this chat) can only explain how to use the application and summarise the signed-in user's own information. It cannot change data, register courses, pay, or take any action for the user.
`;

const STUDENT = `
STUDENT GUIDE (menu names as shown in the sidebar)
- Course registration (menu "Course registration"): lists the courses offered this semester with a verdict for each. Registration only works while a registration period is open for your programme. The page shows your credits against the minimum and maximum. Courses with unmet prerequisites, clashing timetable slots, full capacity or credit-limit problems are blocked or sent as an "exception request" that the academic office must approve (status "pending approval"). You can drop a course until the add/drop deadline.
- Results & appeals (menu "Results & appeals"): shows only PUBLISHED results: continuous assessment, exam, total, grade and grade points, the semester GPA and the cumulative GPA. Marks that are not yet published are invisible to students. If you disagree with a published result use "Appeal" on that course and give a reason; the academic office reviews it and the decision (upheld/rejected) appears on the same page.
- My exams (menu "My exams"): your exam timetable, room, and whether you are eligible to sit each exam. Ineligibility reasons (for example low attendance or unpaid fees) are shown; ask the academic office about an exception.
- File & documents (menu "File & documents"): your official documents (transcript, statement of results, enrolment certificate, registration summary) issued by the academic office. Each has a verification code/QR so third parties can check it online. Request one through "Service requests".
- Service requests (menu "Service requests"): create a request (certificate, transcript, correction, leave, complaint, other), follow its status (submitted, in review, awaiting info, approved, rejected, completed), reply when more information is requested.
- Library (menu "Library"): search the catalogue, see availability, reserve an item that is out, and see your loans and due dates. Overdue items may block some services.
- Assignments & quizzes (menu "Assignments & quizzes") and E-Learning (menu "E-Learning"): submit assignments, take quizzes before their deadline, join live sessions and open course resources.
- Fees (menu "Fees"): shows amounts due, paid and balance. You can pay online with the configured providers (mobile money, card) or upload a bank-transfer proof that the finance office verifies. Receipts are available once a payment is confirmed.
- Attendance (menu "Attendance") and Timetable (menu "Timetable"): your attendance record and weekly schedule.
- Careers & alumni (menu "Careers & alumni"): job postings, applications and the alumni profile. Thesis (menu "My thesis"): milestones, submissions and supervisor feedback.
- Profile (menu "My profile"): personal details and registered programme/class.
`;

const TEACHER = `
LECTURER GUIDE
- My courses (menu "My courses"): the course offerings assigned to you with registered students (roster) and the status of the marks of each course.
- Mark entry (menu "Mark entry" / "My courses"): enter continuous assessment and exam scores per student. Marks go through a workflow: draft (you can edit) → submitted (you submit for validation; locked for you) → approved → published (visible to students). Only the academic office validates and publishes; a rejected submission returns to draft with a reason. Marks can only be entered while the marks session (window) is open when the school uses one.
- Attendance (menu "Attendance"): record attendance for your class. Exams (menu "Exams"): your invigilation duties and exam candidates. Assignments & quizzes: create and grade assessments. Thesis supervision: review milestones and submissions of supervised students. E-Learning: schedule live sessions and upload resources.
- Salary (menu "Salary"): your payslips and withdrawal requests.
`;

const PARENT = `
PARENT GUIDE
- My children (menu "My children"): see each linked child's marks, attendance, fees and behaviour as published by the school. The dashboard summarises them.
`;

const ADMIN = `
ADMINISTRATOR / ACADEMIC OFFICE GUIDE
- Structure, Course catalogue, Course offerings: define faculties, departments, programmes, courses (with prerequisites) and open offerings per semester with a lecturer, capacity and timetable slots.
- Registration: set registration periods (opening/closing, add/drop deadline, minimum/maximum credits) and decide exception requests.
- Results validation: review the marks lecturers submit, approve and publish them (or reject with a reason); publishing makes them visible to students. Appeals are handled from the same area.
- Exams: schedule exams, assign invigilators, check candidate eligibility (attendance and fee rules from "Academic rules") and record overrides with a reason.
- Progression: compute promotion/repeat/graduation proposals from published results, then approve and apply them.
- Official documents: issue and revoke transcripts, statements of results, certificates; each carries a verification code.
- Student file: the 360° record of a student. Service desk: process student requests. Library, Rooms, Timetable, Careers & alumni, Thesis, Broadcasts (announcements), Notifications.
- Analytics (menu "Analytics"): executive dashboards (enrolment, pass rates, GPA distribution, attendance, exams, and finance for administrators and finance officers), with filters and CSV export.
- Security (menu "Security", administrators only): sign-in events, locked accounts (unlock), forced password reset, CSV export.
- Users and password resets are managed under Settings by the school administrator.
`;

const FINANCE = `
FINANCE OFFICER GUIDE
- Dashboard, Transactions (verify bank-transfer proofs, review payments flagged for review, refunds), Reconciliation (compare provider records with the school's records) and Reports (collection figures, export). Fee records and receipts are tied to each payment. Analytics offers the finance dashboard (due, collected, outstanding, overdue, payment-method split).
`;

const LIBRARIAN = `
LIBRARIAN GUIDE
- Library (menu "Library"): manage the catalogue, issue and return loans, handle reservations and overdue items, and the library settings (loan periods, limits).
`;

const BY_ROLE = {
  student: [STUDENT],
  teacher: [TEACHER],
  parent: [PARENT],
  super_admin: [ADMIN, FINANCE],
  academic_officer: [ADMIN],
  finance_officer: [FINANCE],
  librarian: [LIBRARIAN],
};

const ROLE_LABEL = { student: 'student', teacher: 'lecturer', parent: 'parent', super_admin: 'school administrator', academic_officer: 'academic officer', finance_officer: 'finance officer', librarian: 'librarian' };

/** Knowledge base text for a role (head_teacher is the legacy alias of super_admin). */
function knowledgeFor(role) {
  const r = role === 'head_teacher' ? 'super_admin' : role;
  return [COMMON, ...(BY_ROLE[r] || [])].join('\n').trim();
}
const roleLabel = role => ROLE_LABEL[role === 'head_teacher' ? 'super_admin' : role] || 'user';

module.exports = { knowledgeFor, roleLabel };
