import { Video, Phone, Calendar } from "lucide-react";
import { useMeetingInvite, useRespondToInvite } from "../../ipc/queries";
import { commands } from "../../ipc/bindings";
import type { RsvpStatus } from "../../ipc/bindings";
import { useUiStore } from "../../app/store";
import { formatMeetingRange, providerLabel } from "../../shared/meeting/meeting";

const RSVP_OPTIONS: { status: RsvpStatus; label: string }[] = [
  { status: "accepted", label: "Accept" },
  { status: "tentative", label: "Tentative" },
  { status: "declined", label: "Decline" },
];

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function MeetingInviteCard({ messageId }: { messageId: number }) {
  const { data } = useMeetingInvite(messageId);
  const respond = useRespondToInvite();
  const timeFormat = useUiStore((s) => s.timeFormat);

  if (!data || data.start_epoch == null) return null;

  const when = formatMeetingRange(data.start_epoch, data.end_epoch, data.all_day, timeFormat);
  const joinUrl = data.join_url && isHttpsUrl(data.join_url) ? data.join_url : null;
  const dialDigits = data.dial_in ? data.dial_in.replace(/[^0-9+]/g, "") : "";

  return (
    <div className="meeting-card">
      <div className="meeting-card__head">
        <Calendar size={18} className="meeting-card__icon" />
        <div className="meeting-card__title-wrap">
          <span className="meeting-card__title">{data.title}</span>
          <span className="meeting-card__when">{when}</span>
        </div>
        {data.cancelled && (
          <span className="meeting-card__badge meeting-card__badge--cancelled">Cancelled</span>
        )}
        {!data.cancelled && <span className="meeting-card__badge">{providerLabel(data.provider)}</span>}
      </div>

      <dl className="meeting-card__meta">
        {data.organizer && (
          <div className="meeting-card__row">
            <dt>Organizer</dt>
            <dd>{data.organizer_name || data.organizer}</dd>
          </div>
        )}
        {data.location && (
          <div className="meeting-card__row">
            <dt>Location</dt>
            <dd>{data.location}</dd>
          </div>
        )}
      </dl>

      {!data.cancelled && data.response && (
        <p className="meeting-card__response">Your response: {data.response}</p>
      )}

      {!data.cancelled && (
        <div className="meeting-card__actions">
          {data.can_rsvp && (
            <div className="meeting-card__rsvp" role="group" aria-label="Respond to invitation">
              {RSVP_OPTIONS.map((o) => (
                <button
                  key={o.status}
                  type="button"
                  className={`meeting-card__rsvp-btn${data.response === o.status ? " meeting-card__rsvp-btn--active" : ""}`}
                  onClick={() => respond.mutate({ messageId, status: o.status })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {joinUrl && (
            <button
              type="button"
              className="meeting-card__join"
              onClick={() => commands.openExternalUrl(joinUrl)}
            >
              <Video size={16} /> Join meeting
            </button>
          )}
          {dialDigits && (
            <button
              type="button"
              className="meeting-card__dialin"
              onClick={() => commands.openExternalUrl(`tel:${dialDigits}`)}
            >
              <Phone size={14} /> {data.dial_in}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
