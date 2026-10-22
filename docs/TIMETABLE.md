# Rooms & timetable engine

Routes: `src/routes/rooms.js` (`/api/rooms`), `src/routes/timetableEngine.js` (`/api/timetable-engine`); logic in `src/timetable/core.js` (occupancy) and `src/timetable/engine.js` (views, conflicts, iCalendar). Tests: `scripts/test-timetable.js`.

## Data model used
`Room`, `RoomBooking`, `TimetablePeriod` (P1–P8 seeded), `OfferingSlot` (`day`, `period_key`, `room_id` + legacy `room` string), `ExamSession` (`date`, `start/end_time`, `room_id` + `room`). No schema change.

**Legacy room strings.** Existing code (offerings/exams modules) still writes the free-text `room`. Wherever occupancy is computed, a row with `room_id = null` and a `room` string equal (case-insensitive) to a room's `code` or `name` is treated as occupying that room. Assigning through `/rooms/assign-*` sets both `room_id` and `room = room.code`; renaming a room code re-syncs the strings.

## Permissions
- Rooms/bookings read (`GET /rooms`, `/rooms/bookings`, `/rooms/available`): super_admin, academic_officer, teacher. Writes, assignments: super_admin, academic_officer only. `GET /rooms/periods`: any authenticated user.
- Timetable views: student → only own (`/student/me` or own id), lecturer → only own, staff (super_admin, head_teacher, academic_officer) → anyone; room and programme views, conflicts, options: staff only. Librarian/finance/parent: 403.

## Endpoints
**Periods** `GET/POST /rooms/periods`, `PUT/DELETE /rooms/periods/:id` — key upper-cased, immutable; times `HH:MM`, end > start, **no overlap** (touching is fine) → 409; cannot delete while slots use the key.
**Rooms** `GET/POST /rooms`, `GET/PUT/DELETE /rooms/:id` — `code` unique (upper-cased), `capacity` ≥ 1, kind classroom|lab|lecture_hall|exam_hall|other. Delete refused (409) while referenced → deactivate.
**Bookings** `GET /rooms/bookings`, `POST /rooms/bookings`, `POST /rooms/bookings/:id/cancel`. Creation locks the room row and checks conflicts against other bookings, weekly slots (term covers the date, weekday matches, period overlaps) and exam sessions → 409 `{code:'room_conflict', conflicts:[{kind,id,title,…}]}`. Concurrent bookings of the same room: exactly one wins.
**Availability** `GET /rooms/available?date&start_time&end_time` or `?day&period_key[&term_id]`, plus `min_capacity`, `kind`, `all=true` (also lists busy rooms with what occupies them).
**Assignment** `GET /rooms/assignments?term_id` (slots with enrolment, exams with candidates), `POST /rooms/assign-slot {slot_id | offering_id+day+period_key, room_id|null, override_reason?}`, `POST /rooms/assign-exam {exam_id, room_id|null, override_reason?}`.
  - Slot: refused when another slot of the same term/day/period holds the room, or an exam/booking falls on that weekday inside the term at an overlapping time (`room_conflict`); refused when `room.capacity < max(enrolled registered students, offering.capacity)` (`code:'capacity'`) unless `override_reason` (≥ 3 chars) is given — the override is audited (`slot.assign-room`, reason `capacity override: …`) and flagged in the response. Inactive room → 409, unknown period → 422.
  - Exam: same date/time conflict logic against other (non-cancelled) exams, bookings and weekly classes; capacity = candidates (or enrolled students if no candidates yet). Only `scheduled` exams can be assigned.
  - All assignments are audited in `academic_audit`.

**Engine** (`/api/timetable-engine`)
- `GET /student/:id|me`, `/lecturer/:id|me`, `/room/:id`, `/programme/:id?level_id=` (`term_id` optional, default = current term). Response: `{view, subject, term, periods, entries[], exams[], bookings[]}`; an entry = slot + period times + course + lecturer + room. Students: their `registered` enrolments (dropped/pending are excluded); upcoming exams where they are a candidate or the exam belongs to a registered offering (`past=true` returns the whole semester). Programme view uses the curriculum (`programme_courses` for the term's semester + level).
- `GET /conflicts?term_id` (staff). Types and severity: `lecturer_double_booked` (error), `room_double_booked` (error; slot vs slot, slot vs exam, exam vs booking), `student_clash` (error; two registered offerings in the same day/period), `unknown_period` (error), `exam_room_double_booked` (error), `exam_student_clash` (error), `room_over_capacity` (warning; slots and exams), `room_inactive` (warning), `no_room` (info). Each item has `message`, ids (`slot_ids`, `offering_ids`, `exam_ids`), `links` to the fixing pages.
- `GET /student/:id|me/ics`, `GET /lecturer/:id|me/ics` — RFC 5545: one weekly `VEVENT` per slot (`DTSTART` = first matching weekday on/after term start, local "floating" time, `RRULE:FREQ=WEEKLY;UNTIL=<term end>T235900`) and one `VEVENT` per upcoming exam; CRLF, 75-octet folding (UTF-8 safe), text escaping, UTC `DTSTAMP`, stable `UID`s.
- `GET /options`, `GET /students?q=` (staff) feed the selectors of the UI.

## Not done / limits
- Times are floating local times (no `VTIMEZONE`): calendar apps interpret them in the viewer's zone. Public holidays / cancelled weeks are not modelled (no `EXDATE`).
- Conflict detection is by semester; no automatic timetable generation/optimisation — the engine reports, staff fix.
- Slots store no explicit date range: a slot runs for the whole term. Weekend days are not in the `Day` enum.
- The "student clash" report loads all registered enrolments of the term (fine for a few thousand; not paginated).
- Rooms are not checked when the *offerings* or *exams* modules change slot times/periods or write the legacy `room` string themselves; run the conflicts report to see anything that slipped through.
