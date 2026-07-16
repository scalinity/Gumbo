import EventKit
import Foundation

/// M5: mirrors Gumbo's scheduled reminders into Reminders.app via EventKit — the
/// OS-durable half of the reminder pair. Reminders.app fires at the OS level even if the
/// daemon is off or the Mac was asleep at fire time; the daemon's own scheduler is the
/// spoken half while Gumbo is awake. EventKit, not AppleScript (SPEC M5): the AppleScript
/// bridge is ~100× slower and would drag Automation TCC into the picture.
final class RemindersBridge {
    private let store = EKEventStore()

    /// Create a reminder due at `fireAtMs` (epoch-ms, matching the wire protocol).
    /// Completes on the main queue with the EventKit identifier, or nil when access is
    /// denied / no calendar exists / the save fails — the daemon treats nil as "no
    /// Reminders.app twin" and its own scheduler still fires the reminder.
    func create(text: String, fireAtMs: Double, completion: @escaping (String?) -> Void) {
        // The first call triggers the TCC prompt (NSRemindersFullAccessUsageDescription);
        // later calls resolve instantly against the stored grant.
        store.requestFullAccessToReminders { [store] granted, error in
            if let error {
                NSLog("RemindersBridge: access error: \(error.localizedDescription)")
            }
            guard granted,
                  let calendar = store.defaultCalendarForNewReminders() ?? store.calendars(for: .reminder).first
            else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let reminder = EKReminder(eventStore: store)
            reminder.title = text
            reminder.calendar = calendar
            let due = Date(timeIntervalSince1970: fireAtMs / 1000)
            // Due-date components make it show under the right day; the absolute alarm is
            // what makes Reminders.app actually notify at fire time.
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: due)
            reminder.addAlarm(EKAlarm(absoluteDate: due))
            do {
                try store.save(reminder, commit: true)
                let id = reminder.calendarItemIdentifier
                DispatchQueue.main.async { completion(id) }
            } catch {
                NSLog("RemindersBridge: save failed: \(error.localizedDescription)")
                DispatchQueue.main.async { completion(nil) }
            }
        }
    }

    /// Best-effort removal of a cancelled reminder's Reminders.app entry (the daemon
    /// already cancelled its own row — a failure here just leaves a stale entry).
    func remove(eventkitId: String) {
        store.requestFullAccessToReminders { [store] granted, _ in
            guard granted, let item = store.calendarItem(withIdentifier: eventkitId) as? EKReminder else { return }
            do {
                try store.remove(item, commit: true)
            } catch {
                NSLog("RemindersBridge: remove failed: \(error.localizedDescription)")
            }
        }
    }
}
