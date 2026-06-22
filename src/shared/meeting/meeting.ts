import type { MeetingInvite, MeetingProvider } from "../../ipc/bindings";
import type { TimeFormat } from "../general/general";
import { hour12Option } from "../datetime/datetime";

export function providerLabel(provider: MeetingProvider): string {
  switch (provider) {
    case "teams":
      return "Microsoft Teams";
    case "google_meet":
      return "Google Meet";
    case "zoom":
      return "Zoom";
    case "webex":
      return "Webex";
    default:
      return "Online meeting";
  }
}

export function meetingBadgeLabel(
  invite: Pick<MeetingInvite, "provider" | "join_url" | "dial_in">,
): string {
  if (invite.provider !== "other") return providerLabel(invite.provider);
  if (invite.join_url || invite.dial_in) return "Online meeting";
  return "Event";
}

export function formatMeetingRange(
  startEpoch: number,
  endEpoch: number | null,
  allDay: boolean,
  timeFormat: TimeFormat,
): string {
  const start = new Date(startEpoch * 1000);
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  if (allDay) {
    if (endEpoch != null) {
      const lastDay = new Date((endEpoch - 86400) * 1000);
      if (lastDay.getTime() > start.getTime()) {
        const rangeFmt = new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
        return rangeFmt.formatRange(start, lastDay);
      }
    }
    return dateFmt.format(start);
  }
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12Option(timeFormat),
  });
  const datePart = dateFmt.format(start);
  const startTime = timeFmt.format(start);
  if (endEpoch == null) {
    return `${datePart}, ${startTime}`;
  }
  const end = new Date(endEpoch * 1000);
  return `${datePart}, ${startTime}–${timeFmt.format(end)}`;
}
