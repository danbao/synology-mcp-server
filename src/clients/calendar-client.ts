/**
 * Synology Calendar API client.
 * Wraps SYNO.Cal.Cal (calendar management) and SYNO.Cal.Event (event CRUD).
 * All datetime fields are Unix seconds on the wire; callers pass/receive ISO 8601.
 * Per spec §7.4.
 */

import { BaseClient } from './base-client.js';
import type { AuthManager } from '../auth/auth-manager.js';
import type { SynologyConfig } from '../types/index.js';

const ENTRY = '/webapi/entry.cgi';
const EVENT_API_VERSION = 6;
const CALENDAR_CREATE_VERSION = 5;
const DEFAULT_CALENDAR_COLOR = '#4A90E2';

// ---------------------------------------------------------------------------
// Wire-level shapes (Synology API)
// ---------------------------------------------------------------------------

/** Calendar entry as returned by SYNO.Cal.Cal list */
export interface SynoCalendar {
  cal_id: string;
  original_cal_id?: string;
  name: string;
  color: string;
  is_owner: boolean;
  is_shared: boolean;
  description: string;
}

/** Attendee as stored in the Synology event */
export interface SynoAttendee {
  email: string;
  name: string;
  status?: string;
}

/** Event as returned by SYNO.Cal.Event */
export interface SynoCalEvent {
  evt_id: string;
  cal_id: string;
  original_cal_id?: string;
  cal_name: string;
  title: string;
  desc: string;
  location: string;
  dtstart: number;
  dtend: number;
  is_all_day: boolean;
  rrule?: string;
  attendee?: SynoAttendee[];
  dav_etag?: string;
  color?: string;
  tz_id?: string;
  is_repeat_evt?: boolean;
  repeat_setting?: unknown;
  participant?: unknown[];
  notify_setting?: unknown[];
  location_info?: CalendarLocationInfo;
  attachments?: unknown[];
}

/** Normalized list response from SYNO.Cal.Event list */
export interface SynoEventListResponse {
  total: number;
  events: SynoCalEvent[];
}

/** Raw list response returned by newer Calendar packages. */
interface SynoEventListRawResponse {
  total?: number;
  events?: SynoCalEventRaw[];
  list?: SynoCalEventRaw[];
}

/** Raw create/update response from SYNO.Cal.Event */
interface SynoEventMutateResponse {
  evt_id: string;
  cal_id: string;
}

/** Raw create response from SYNO.Cal.Cal create */
interface SynoCalCreateResponse {
  cal_id: string;
}

interface SynoCalendarRaw {
  cal_id: string;
  original_cal_id?: string;
  name?: string;
  cal_displayname?: string;
  color?: string;
  cal_color?: string;
  is_owner?: boolean;
  is_shared?: boolean;
  description?: string;
  cal_description?: string;
}

interface CalendarLocationInfo {
  name: string;
  address: string;
  placeId: string;
  mapType: string;
  gps: { lat: number; lng: number };
}

interface SynoCalEventRaw {
  evt_id: string | number;
  cal_id: string;
  original_cal_id?: string;
  cal_name?: string;
  cal_displayname?: string;
  title?: string;
  summary?: string;
  desc?: string;
  description?: string;
  location?: string;
  location_info?: CalendarLocationInfo;
  dtstart: number;
  dtend: number;
  is_all_day: boolean;
  rrule?: string;
  repeat_setting?: unknown;
  attendee?: SynoAttendee[];
  participant?: unknown[];
  dav_etag?: string;
  color?: string;
  tz_id?: string;
  is_repeat_evt?: boolean;
  notify_setting?: unknown[];
  attachments?: unknown[];
}

interface CalendarSettingResponse {
  time_zone?: string;
}

function setJsonBodyParam(body: URLSearchParams, key: string, value: unknown): void {
  body.set(key, JSON.stringify(value));
}

function jsonQueryParam(value: unknown): string {
  return JSON.stringify(value);
}

function eventIdParam(eventId: string): string | number {
  return /^\d+$/.test(eventId) ? Number(eventId) : eventId;
}

function normalizeCalendar(raw: SynoCalendarRaw): SynoCalendar {
  return {
    cal_id: raw.cal_id,
    ...(raw.original_cal_id !== undefined ? { original_cal_id: raw.original_cal_id } : {}),
    name: raw.name ?? raw.cal_displayname ?? raw.cal_id,
    color: raw.color ?? raw.cal_color ?? '',
    is_owner: raw.is_owner ?? true,
    is_shared: raw.is_shared ?? false,
    description: raw.description ?? raw.cal_description ?? '',
  };
}

function normalizeEvent(raw: SynoCalEventRaw): SynoCalEvent {
  const location = raw.location ?? raw.location_info?.name ?? '';
  return {
    evt_id: String(raw.evt_id),
    cal_id: raw.cal_id,
    ...(raw.original_cal_id !== undefined ? { original_cal_id: raw.original_cal_id } : {}),
    cal_name: raw.cal_name ?? raw.cal_displayname ?? '',
    title: raw.title ?? raw.summary ?? '',
    desc: raw.desc ?? raw.description ?? '',
    location,
    dtstart: raw.dtstart,
    dtend: raw.dtend,
    is_all_day: raw.is_all_day,
    ...(raw.rrule !== undefined ? { rrule: raw.rrule } : {}),
    ...(raw.attendee !== undefined ? { attendee: raw.attendee } : {}),
    ...(raw.dav_etag !== undefined ? { dav_etag: raw.dav_etag } : {}),
    ...(raw.color !== undefined ? { color: raw.color } : {}),
    ...(raw.tz_id !== undefined ? { tz_id: raw.tz_id } : {}),
    ...(raw.is_repeat_evt !== undefined ? { is_repeat_evt: raw.is_repeat_evt } : {}),
    ...(raw.repeat_setting !== undefined ? { repeat_setting: raw.repeat_setting } : {}),
    ...(raw.participant !== undefined ? { participant: raw.participant } : {}),
    ...(raw.notify_setting !== undefined ? { notify_setting: raw.notify_setting } : {}),
    ...(raw.location_info !== undefined ? { location_info: raw.location_info } : {}),
    ...(raw.attachments !== undefined ? { attachments: raw.attachments } : {}),
  };
}

function normalizeMutation(raw: { evt_id: string | number; cal_id: string }): SynoEventMutateResponse {
  return { evt_id: String(raw.evt_id), cal_id: raw.cal_id };
}

function makeLocationInfo(location: string): CalendarLocationInfo {
  return {
    name: location,
    address: '',
    placeId: '',
    mapType: '',
    gps: { lat: -1, lng: -1 },
  };
}

function mapParticipants(attendees: CreateEventOpts['attendees']): unknown[] {
  return (attendees ?? []).map((attendee) => ({
    email: attendee.email,
    name: attendee.name ?? attendee.email,
    role: 'attendee',
    status: 'needs-action',
  }));
}

function fallbackTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// ---------------------------------------------------------------------------
// Input option types (exposed to tool layer)
// ---------------------------------------------------------------------------

/** Options for listEvents */
export interface ListEventsOpts {
  calendar_id?: string | undefined;
  start_unix: number;
  end_unix: number;
  limit?: number | undefined;
}

/** Options for createEvent */
export interface CreateEventOpts {
  calendar_id: string;
  title: string;
  dtstart: number;
  dtend: number;
  is_all_day: boolean;
  description?: string | undefined;
  location?: string | undefined;
  attendees?: Array<{ email: string; name?: string | undefined }> | undefined;
  recurrence?: string | undefined;
  reminder_minutes?: number | undefined;
}

/** Options for updateEvent */
export interface UpdateEventOpts {
  event_id: string;
  calendar_id: string;
  title?: string | undefined;
  dtstart?: number | undefined;
  dtend?: number | undefined;
  description?: string | undefined;
  location?: string | undefined;
}

/** Options for createCalendar */
export interface CreateCalendarOpts {
  name: string;
  color?: string | undefined;
  description?: string | undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Wraps all SYNO.Cal.Cal and SYNO.Cal.Event operations.
 * Datetime values are in Unix seconds on the wire.
 */
export class CalendarClient extends BaseClient {
  constructor(config: SynologyConfig, authManager: AuthManager) {
    super(config, authManager);
  }

  /**
   * List all calendars accessible to the authenticated user.
   *
   * @returns Array of calendar entries.
   */
  async listCalendars(): Promise<SynoCalendar[]> {
    const raw = await this.request<SynoCalendarRaw[]>({
      endpoint: ENTRY,
      method: 'GET',
      params: { api: 'SYNO.Cal.Cal', version: 1, method: 'list' },
    });
    return raw.map(normalizeCalendar);
  }

  /**
   * List events within a Unix-second time range.
   *
   * @param opts - Query options including optional calendar_id, start/end, limit.
   */
  async listEvents(opts: ListEventsOpts): Promise<SynoEventListResponse> {
    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.Cal.Event',
      version: EVENT_API_VERSION,
      method: 'list',
      start: jsonQueryParam(opts.start_unix),
      end: jsonQueryParam(opts.end_unix),
      limit: jsonQueryParam(opts.limit ?? 100),
    };
    if (opts.calendar_id !== undefined) {
      params['cal_id_list'] = jsonQueryParam([opts.calendar_id]);
    }

    const raw = await this.request<SynoEventListRawResponse>({
      endpoint: ENTRY,
      method: 'GET',
      params,
    });
    const events = (raw.events ?? raw.list ?? []).map(normalizeEvent);
    return {
      total: raw.total ?? events.length,
      events,
    };
  }

  /**
   * Fetch a single event by ID.
   *
   * @param event_id - Event identifier.
   * @param calendar_id - Owning calendar identifier.
   */
  async getEvent(event_id: string, _calendar_id: string): Promise<SynoCalEvent> {
    void _calendar_id;
    const body = new URLSearchParams();
    setJsonBodyParam(body, 'evt_id', eventIdParam(event_id));

    const raw = await this.request<SynoCalEventRaw>({
      endpoint: ENTRY,
      method: 'POST',
      params: {
        api: 'SYNO.Cal.Event',
        version: EVENT_API_VERSION,
        method: 'get',
      },
      body,
    });
    return normalizeEvent(raw);
  }

  /**
   * Create a new calendar event.
   *
   * @param opts - Event properties with datetimes as Unix seconds.
   */
  async createEvent(opts: CreateEventOpts): Promise<SynoEventMutateResponse> {
    const calendar = await this.getCalendarIdentity(opts.calendar_id);
    const timeZone = opts.is_all_day ? '' : await this.getCalendarTimeZone();
    const body = new URLSearchParams();
    setJsonBodyParam(body, 'cal_id', calendar.cal_id);
    setJsonBodyParam(body, 'original_cal_id', calendar.original_cal_id);
    setJsonBodyParam(body, 'summary', opts.title);
    setJsonBodyParam(body, 'is_all_day', opts.is_all_day);
    setJsonBodyParam(body, 'tz_id', timeZone);
    setJsonBodyParam(body, 'dtstart', opts.dtstart);
    setJsonBodyParam(body, 'dtend', opts.dtend);
    setJsonBodyParam(body, 'is_repeat_evt', false);
    setJsonBodyParam(body, 'color', '');
    setJsonBodyParam(body, 'description', opts.description ?? '');
    setJsonBodyParam(body, 'participant', mapParticipants(opts.attendees));
    setJsonBodyParam(body, 'notify_setting', []);
    if (opts.location !== undefined) {
      setJsonBodyParam(body, 'location_info', makeLocationInfo(opts.location));
    }

    const raw = await this.request<{ evt_id: string | number; cal_id: string }>({
      endpoint: ENTRY,
      method: 'POST',
      params: { api: 'SYNO.Cal.Event', version: EVENT_API_VERSION, method: 'create' },
      body,
    });
    return normalizeMutation(raw);
  }

  /**
   * Update an existing calendar event. Only supplied fields are changed.
   *
   * @param opts - Partial event properties plus required event_id/calendar_id.
   */
  async updateEvent(opts: UpdateEventOpts): Promise<SynoEventMutateResponse> {
    const current = await this.getEvent(opts.event_id, opts.calendar_id);
    const calendar = await this.getCalendarIdentity(opts.calendar_id);
    const isAllDay = current.is_all_day;
    const timeZone = isAllDay ? '' : (current.tz_id ?? (await this.getCalendarTimeZone()));
    const body = new URLSearchParams();
    setJsonBodyParam(body, 'evt_id', eventIdParam(opts.event_id));
    setJsonBodyParam(body, 'cal_id', calendar.cal_id);
    setJsonBodyParam(body, 'original_cal_id', calendar.original_cal_id);
    setJsonBodyParam(body, 'summary', opts.title ?? current.title);
    setJsonBodyParam(body, 'is_all_day', isAllDay);
    setJsonBodyParam(body, 'tz_id', timeZone);
    setJsonBodyParam(body, 'dtstart', opts.dtstart ?? current.dtstart);
    setJsonBodyParam(body, 'dtend', opts.dtend ?? current.dtend);
    setJsonBodyParam(body, 'is_repeat_evt', current.is_repeat_evt ?? false);
    setJsonBodyParam(body, 'color', current.color ?? '');
    setJsonBodyParam(body, 'description', opts.description ?? current.desc);
    setJsonBodyParam(body, 'participant', current.participant ?? []);
    setJsonBodyParam(body, 'notify_setting', current.notify_setting ?? []);
    if (current.dav_etag !== undefined) setJsonBodyParam(body, 'dav_etag', current.dav_etag);
    if (current.repeat_setting !== undefined) {
      setJsonBodyParam(body, 'repeat_setting', current.repeat_setting);
    }
    if (current.attachments !== undefined) {
      setJsonBodyParam(body, 'attachments', current.attachments);
    }
    const locationInfo =
      opts.location !== undefined ? makeLocationInfo(opts.location) : current.location_info;
    if (locationInfo !== undefined) setJsonBodyParam(body, 'location_info', locationInfo);

    const raw = await this.request<{ evt_id: string | number; cal_id: string }>({
      endpoint: ENTRY,
      method: 'POST',
      params: {
        api: 'SYNO.Cal.Event',
        version: EVENT_API_VERSION,
        method: 'set',
      },
      body,
    });
    return normalizeMutation(raw);
  }

  /**
   * Delete an event.
   *
   * @param event_id - Event to delete.
   * @param calendar_id - Owning calendar.
   */
  deleteEvent(event_id: string, _calendar_id: string): Promise<Record<string, never>> {
    void _calendar_id;
    const body = new URLSearchParams();
    setJsonBodyParam(body, 'evt_id', eventIdParam(event_id));

    return this.request<Record<string, never>>({
      endpoint: ENTRY,
      method: 'POST',
      params: { api: 'SYNO.Cal.Event', version: EVENT_API_VERSION, method: 'delete' },
      body,
      allowEmptyData: true,
    });
  }

  /**
   * Create a new calendar.
   *
   * @param opts - Calendar name, optional color and description.
   */
  createCalendar(opts: CreateCalendarOpts): Promise<SynoCalCreateResponse> {
    const body = new URLSearchParams();
    setJsonBodyParam(body, 'cal_displayname', opts.name);
    setJsonBodyParam(body, 'cal_color', opts.color ?? DEFAULT_CALENDAR_COLOR);
    setJsonBodyParam(body, 'cal_description', opts.description ?? '');

    return this.request<SynoCalCreateResponse>({
      endpoint: ENTRY,
      method: 'POST',
      params: { api: 'SYNO.Cal.Cal', version: CALENDAR_CREATE_VERSION, method: 'create' },
      body,
    });
  }

  private async getCalendarIdentity(
    calendarId: string,
  ): Promise<{ cal_id: string; original_cal_id: string }> {
    try {
      const calendars = await this.listCalendars();
      const calendar = calendars.find((item) => item.cal_id === calendarId);
      return {
        cal_id: calendar?.cal_id ?? calendarId,
        original_cal_id: calendar?.original_cal_id ?? calendar?.cal_id ?? calendarId,
      };
    } catch {
      return { cal_id: calendarId, original_cal_id: calendarId };
    }
  }

  private async getCalendarTimeZone(): Promise<string> {
    try {
      const setting = await this.request<CalendarSettingResponse>({
        endpoint: ENTRY,
        method: 'GET',
        params: { api: 'SYNO.Cal.Setting', version: 5, method: 'get' },
      });
      return setting.time_zone ?? fallbackTimeZone();
    } catch {
      return fallbackTimeZone();
    }
  }
}
