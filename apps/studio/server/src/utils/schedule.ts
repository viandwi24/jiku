import type { AvailabilitySchedule } from '@jiku/types'

export type { AvailabilitySchedule }

/**
 * Check if the current time falls within an availability schedule.
 * Returns true if the current time is within at least one of the schedule windows.
 */
export function isWithinSchedule(schedule: AvailabilitySchedule): boolean {
  if (!schedule.enabled) return true
  if (!schedule.hours || schedule.hours.length === 0) return true

  let now: Date
  try {
    // Get current time in the schedule's timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    })
    const parts = formatter.formatToParts(new Date())
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
    const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? ''

    // Map weekday string to number
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    }
    const dayOfWeek = weekdayMap[weekdayStr] ?? new Date().getDay()
    const currentMinutes = hour * 60 + minute

    for (const window of schedule.hours) {
      if (!window.days.includes(dayOfWeek)) continue

      const [fromH, fromM] = window.from.split(':').map(Number)
      const [toH, toM] = window.to.split(':').map(Number)
      const fromMinutes = (fromH ?? 0) * 60 + (fromM ?? 0)
      const toMinutes = (toH ?? 0) * 60 + (toM ?? 0)

      if (currentMinutes >= fromMinutes && currentMinutes < toMinutes) {
        return true
      }
    }

    return false
  } catch {
    // If timezone parsing fails, assume available (graceful fallback)
    return true
  }
}
