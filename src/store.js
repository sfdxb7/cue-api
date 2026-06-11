const defaultStoreTimeoutMs = 10 * 1000;

export function createSupabaseStore(options = {}) {
  const url = (options.url ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? defaultStoreTimeoutMs;

  if (!url || !serviceKey || typeof fetchImpl !== "function") {
    return null;
  }

  async function request(method, path, { body, prefer, expectRows = true } = {}) {
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    };

    if (prefer) {
      headers.Prefer = prefer;
    }

    let response;

    try {
      response = await fetchImpl(`${url}/rest/v1${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      throw createStoreError("Persistence backend is unreachable.");
    }

    if (!response.ok) {
      throw createStoreError(`Persistence backend rejected the request (${response.status}).`);
    }

    if (!expectRows) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return {
    async listMeetings(deviceId) {
      const rows = await request(
        "GET",
        `/meetings?select=*,moments(*)&device_id=eq.${encodeURIComponent(deviceId)}&order=updated_at.desc`
      );

      return Array.isArray(rows) ? rows.map(meetingRowToClient) : [];
    },

    async upsertMeeting(deviceId, meeting) {
      const rows = await request("POST", "/meetings?on_conflict=id", {
        body: [meetingClientToRow(deviceId, meeting)],
        prefer: "resolution=merge-duplicates,return=representation"
      });

      const row = Array.isArray(rows) ? rows[0] : null;
      const moments = Array.isArray(meeting.moments) ? meeting.moments : [];

      if (moments.length > 0) {
        await this.insertMoments(deviceId, meeting.id, moments);
      }

      return row ? meetingRowToClient({ ...row, moments }) : null;
    },

    async patchMeeting(deviceId, meetingId, patch) {
      const rows = await request(
        "PATCH",
        `/meetings?id=eq.${encodeURIComponent(meetingId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
        {
          body: meetingPatchToRow(patch),
          prefer: "return=representation"
        }
      );

      const row = Array.isArray(rows) ? rows[0] : null;
      return row ? meetingRowToClient(row) : null;
    },

    async deleteMeeting(deviceId, meetingId) {
      const rows = await request(
        "DELETE",
        `/meetings?id=eq.${encodeURIComponent(meetingId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
        { prefer: "return=representation" }
      );

      return Array.isArray(rows) && rows.length > 0;
    },

    async insertMoments(deviceId, meetingId, moments) {
      await request("POST", "/moments?on_conflict=meeting_id,id", {
        body: moments.map((moment) => momentClientToRow(deviceId, meetingId, moment)),
        prefer: "resolution=merge-duplicates",
        expectRows: false
      });

      return moments.length;
    },

    async putTranscript(deviceId, meetingId, content) {
      await request("POST", "/transcripts?on_conflict=meeting_id", {
        body: [
          {
            meeting_id: meetingId,
            device_id: deviceId,
            content,
            updated_at: new Date().toISOString()
          }
        ],
        prefer: "resolution=merge-duplicates",
        expectRows: false
      });
    },

    async getTranscript(deviceId, meetingId) {
      const rows = await request(
        "GET",
        `/transcripts?select=content&meeting_id=eq.${encodeURIComponent(meetingId)}&device_id=eq.${encodeURIComponent(deviceId)}`
      );

      return Array.isArray(rows) && rows[0] ? rows[0].content : null;
    },

    async searchMemory(deviceId, query, limit) {
      const results = await request("POST", "/rpc/search_memory", {
        body: { p_device: deviceId, p_query: query, p_limit: limit }
      });

      return Array.isArray(results)
        ? results.map((hit) => ({
            meetingId: hit.meeting_id,
            title: hit.title,
            dateLabel: hit.date_label,
            rank: hit.rank,
            kind: hit.kind,
            momentId: hit.moment_id ?? undefined,
            snippet: hit.snippet
          }))
        : [];
    },

    async listPlaybooks(deviceId) {
      const rows = await request(
        "GET",
        `/playbooks?select=id,name,kind,enabled,source_filename,page_count,created_at&device_id=eq.${encodeURIComponent(deviceId)}&order=created_at.desc`
      );

      return Array.isArray(rows) ? rows.map(playbookRowToClient) : [];
    },

    async getPlaybook(deviceId, playbookId) {
      const rows = await request(
        "GET",
        `/playbooks?id=eq.${encodeURIComponent(playbookId)}&device_id=eq.${encodeURIComponent(deviceId)}`
      );

      const row = Array.isArray(rows) ? rows[0] : null;
      return row ? playbookRowToClient(row) : null;
    },

    async listEnabledPlaybookContents(deviceId) {
      const rows = await request(
        "GET",
        `/playbooks?select=name,content&device_id=eq.${encodeURIComponent(deviceId)}&enabled=is.true&order=created_at.desc`
      );

      return Array.isArray(rows) ? rows : [];
    },

    async insertPlaybook(deviceId, playbook) {
      const rows = await request("POST", "/playbooks", {
        body: [
          {
            device_id: deviceId,
            name: playbook.name,
            kind: playbook.kind,
            content: playbook.content,
            source_filename: playbook.sourceFilename ?? null,
            page_count: playbook.pageCount ?? null
          }
        ],
        prefer: "return=representation"
      });

      const row = Array.isArray(rows) ? rows[0] : null;
      return row ? playbookRowToClient(row) : null;
    },

    async patchPlaybook(deviceId, playbookId, patch) {
      const body = {
        updated_at: new Date().toISOString(),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {})
      };
      const rows = await request(
        "PATCH",
        `/playbooks?id=eq.${encodeURIComponent(playbookId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
        { body, prefer: "return=representation" }
      );

      const row = Array.isArray(rows) ? rows[0] : null;
      return row ? playbookRowToClient(row) : null;
    },

    async deletePlaybook(deviceId, playbookId) {
      const rows = await request(
        "DELETE",
        `/playbooks?id=eq.${encodeURIComponent(playbookId)}&device_id=eq.${encodeURIComponent(deviceId)}`,
        { prefer: "return=representation" }
      );

      return Array.isArray(rows) && rows.length > 0;
    }
  };
}

export function isStoreError(error) {
  return Boolean(error && error.isStoreError);
}

function createStoreError(message) {
  const error = new Error(message);
  error.isStoreError = true;
  return error;
}

function meetingRowToClient(row) {
  return {
    id: row.id,
    title: row.title,
    dateLabel: row.date_label ?? "",
    duration: row.duration ?? "",
    people: row.people ?? 0,
    status: row.status,
    chips: Array.isArray(row.chips) ? row.chips : [],
    minutes: row.minutes ?? { summary: "", decisions: [], actions: [], unclearItems: [] },
    chat: Array.isArray(row.chat) ? row.chat : [],
    moments: Array.isArray(row.moments) ? row.moments.map(momentRowToClient) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function meetingClientToRow(deviceId, meeting) {
  return {
    id: meeting.id,
    device_id: deviceId,
    title: meeting.title,
    date_label: meeting.dateLabel ?? "",
    duration: meeting.duration ?? "",
    people: meeting.people ?? 0,
    status: meeting.status,
    chips: meeting.chips ?? [],
    minutes: meeting.minutes,
    chat: meeting.chat ?? [],
    created_at: meeting.createdAt,
    updated_at: meeting.updatedAt
  };
}

function meetingPatchToRow(patch) {
  const row = { updated_at: patch.updatedAt ?? new Date().toISOString() };

  if (patch.title !== undefined) row.title = patch.title;
  if (patch.dateLabel !== undefined) row.date_label = patch.dateLabel;
  if (patch.duration !== undefined) row.duration = patch.duration;
  if (patch.people !== undefined) row.people = patch.people;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.chips !== undefined) row.chips = patch.chips;
  if (patch.minutes !== undefined) row.minutes = patch.minutes;
  if (patch.chat !== undefined) row.chat = patch.chat;

  return row;
}

function momentRowToClient(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    timestamp: row.timestamp_label,
    context: row.context,
    hasScreenshot: Boolean(row.has_screenshot),
    tags: Array.isArray(row.tags) ? row.tags : []
  };
}

function momentClientToRow(deviceId, meetingId, moment) {
  return {
    meeting_id: meetingId,
    id: moment.id,
    device_id: deviceId,
    type: moment.type,
    title: moment.title,
    summary: moment.summary,
    timestamp_label: moment.timestamp,
    context: moment.context,
    has_screenshot: Boolean(moment.hasScreenshot),
    tags: moment.tags ?? []
  };
}

function playbookRowToClient(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: Boolean(row.enabled),
    sourceFilename: row.source_filename ?? undefined,
    pageCount: row.page_count ?? undefined,
    contentLength: typeof row.content === "string" ? row.content.length : undefined,
    content: typeof row.content === "string" ? row.content : undefined,
    createdAt: row.created_at
  };
}
