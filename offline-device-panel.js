class OfflineDevicePanel extends HTMLElement {
  static getConfigElement() {
    return document.createElement("offline-device-panel-editor");
  }

  static getStubConfig() {
    return {
      title: "Device Status",
      show_online: true,
      display_mode: "detailed",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      areas: [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._filters = this._defaultFilters();
    this._openMulti = null;
    this._registriesLoaded = false;
    this._entities = [];
    this._devices = [];
    this._areas = [];
    this._hass = null;
  }

  setConfig(config) {
    this._config = {
      title: "Offline Devices",
      show_online: true,
      display_mode: "detailed",
      offline_states: ["unavailable", "unknown"],
      columns: "auto",
      domains: [],
      integrations: [],
      areas: [],
      persist_filters: true,
      ...config,
    };
    this._filters = this._normalizedFilters({
      ...this._defaultFilters(),
      ...this._loadFilters(),
    });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadRegistries(hass);
    this._render();
  }

  getCardSize() {
    return 6;
  }

  _defaultFilters() {
    return {
      status: "offline",
      displayMode: this._config?.display_mode === "simple" ? "simple" : "detailed",
      domains: [],
      integrations: [],
      areas: [],
      search: "",
    };
  }

  _storageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "offline-device-panel";
    return `offline-device-panel:filters:${path}:${cardKey}`;
  }

  _loadFilters() {
    if (this._config.persist_filters === false) return {};

    try {
      const value = localStorage.getItem(this._storageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("offline-device-panel: saved filters could not be loaded", error);
      return {};
    }
  }

  _saveFilters() {
    if (this._config.persist_filters === false) return;

    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._normalizedFilters(this._filters)));
    } catch (error) {
      console.warn("offline-device-panel: filters could not be saved", error);
    }
  }

  _normalizedFilters(filters) {
    const status = ["offline", "online", "all"].includes(filters.status) ? filters.status : "offline";
    const displayMode = filters.displayMode === "simple" ? "simple" : "detailed";
    const arrayOrEmpty = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

    return {
      status: this._config.show_online === false && status !== "offline" ? "offline" : status,
      displayMode,
      domains: arrayOrEmpty(filters.domains),
      integrations: arrayOrEmpty(filters.integrations),
      areas: arrayOrEmpty(filters.areas),
      search: typeof filters.search === "string" ? filters.search : "",
    };
  }

  async _loadRegistries(hass) {
    if (this._registriesLoaded || !hass?.callWS) return;
    this._registriesLoaded = true;

    try {
      const [entities, devices, areas] = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/device_registry/list" }),
        hass.callWS({ type: "config/area_registry/list" }),
      ]);
      this._entities = entities || [];
      this._devices = devices || [];
      this._areas = areas || [];
      this._render();
    } catch (error) {
      console.warn("offline-device-panel: registry lookup failed", error);
    }
  }

  _deviceRows() {
    if (!this._hass?.states) return [];

    const entityRegistry = new Map(this._entities.map((entity) => [entity.entity_id, entity]));
    const deviceRegistry = new Map(this._devices.map((device) => [device.id, device]));
    const areaRegistry = new Map(this._areas.map((area) => [area.area_id || area.id, area]));
    const grouped = new Map();

    for (const [entityId, stateObj] of Object.entries(this._hass.states)) {
      const domain = entityId.split(".")[0];
      if (this._config.domains.length && !this._config.domains.includes(domain)) continue;

      const entity = entityRegistry.get(entityId);
      const device = entity?.device_id ? deviceRegistry.get(entity.device_id) : null;
      const integration = this._integration(entity, stateObj);
      if (this._config.integrations.length && !this._config.integrations.includes(integration)) continue;

      const areaId = entity?.area_id || device?.area_id || stateObj.attributes?.area_id || "unknown";
      const area = areaRegistry.get(areaId);
      const areaName = area?.name || stateObj.attributes?.area || (areaId === "unknown" ? "No area" : areaId);
      if (this._config.areas.length && !this._config.areas.includes(areaName) && !this._config.areas.includes(areaId)) continue;

      const key = entity?.device_id || entityId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          entityId,
          name: device?.name_by_user || device?.name || stateObj.attributes?.friendly_name || entityId,
          offline: false,
          domains: new Set(),
          integrations: new Set(),
          states: new Set(),
          offlineEntities: [],
          entityCount: 0,
          areaId,
          areaName,
          lastChanged: stateObj.last_changed,
        });
      }

      const row = grouped.get(key);
      const isOffline = this._isOffline(stateObj.state);
      row.offline = row.offline || isOffline;
      row.domains.add(domain);
      row.integrations.add(integration);
      row.states.add(stateObj.state);
      row.entityCount += 1;
      if (isOffline) {
        row.offlineEntities.push({
          entityId,
          name: stateObj.attributes?.friendly_name || entity?.name || entityId,
          uniqueId: entity?.unique_id || "",
        });
      }
      if (isOffline || !row.lastChanged || new Date(stateObj.last_changed) > new Date(row.lastChanged)) {
        row.lastChanged = stateObj.last_changed;
      }
    }

    const rows = [...grouped.values()].map((row) => {
      const domains = [...row.domains].sort((a, b) => a.localeCompare(b));
      const integrations = [...row.integrations].sort((a, b) => a.localeCompare(b));
      const states = [...row.states].sort((a, b) => a.localeCompare(b));
      return {
        ...row,
        entityId: row.offlineEntities[0]?.entityId || row.entityId,
        domain: domains.join(", "),
        integration: integrations.join(", "),
        state: states.join(", "),
        domains,
        integrations,
        states,
      };
    });

    return rows.sort((a, b) => {
      if (a.offline !== b.offline) return a.offline ? -1 : 1;
      return a.areaName.localeCompare(b.areaName) || a.name.localeCompare(b.name);
    });
  }

  _integration(entity, stateObj) {
    if (entity?.platform) return entity.platform;
    const attr = stateObj.attributes || {};
    return attr.integration || attr.platform || "unknown";
  }

  _isOffline(state) {
    return this._config.offline_states.includes(String(state).toLowerCase());
  }

  _filteredRows() {
    const search = this._filters.search.trim().toLowerCase();

    return this._deviceRows().filter((row) => {
      if (this._filters.status === "offline" && !row.offline) return false;
      if (this._filters.status === "online" && row.offline) return false;
      if (this._filters.domains.length && !this._hasAny(row.domains, this._filters.domains)) return false;
      if (this._filters.integrations.length && !this._hasAny(row.integrations, this._filters.integrations)) return false;
      if (this._filters.areas.length && !this._filters.areas.includes(row.areaName)) return false;
      if (!search) return true;

      const offlineText = row.offlineEntities.map((entity) => `${entity.name} ${entity.entityId} ${entity.uniqueId}`).join(" ");
      const haystack = `${row.name} ${row.entityId} ${offlineText} ${row.areaName} ${row.integration} ${row.domain}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  _hasAny(values, selected) {
    return selected.some((value) => values.includes(value));
  }

  _options(rows, key) {
    const values = rows.flatMap((row) => {
      const value = row[key];
      return Array.isArray(value) ? value : [value];
    });
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _groupByArea(rows) {
    return rows.reduce((groups, row) => {
      const key = row.areaName || "No area";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
      return groups;
    }, new Map());
  }

  _render(options = {}) {
    if (!this.shadowRoot) return;

    const preserveScroll = options.preserveScroll || Boolean(this._openMulti);
    const scrollSnapshots = preserveScroll ? this._scrollSnapshots() : [];
    const openMenu = preserveScroll && this._openMulti ? this.shadowRoot.querySelector(`[data-multi-menu="${this._openMulti}"]`) : null;
    const menuScrollTop = openMenu ? openMenu.scrollTop : 0;
    const menuScrollLeft = openMenu ? openMenu.scrollLeft : 0;

    const allRows = this._deviceRows();
    const rows = this._filteredRows();
    const offlineCount = allRows.filter((row) => row.offline).length;
    const onlineCount = allRows.length - offlineCount;
    const statusText = `${offlineCount} offline / ${onlineCount} online`;

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="panel">
          <header>
            <div>
              <h2>${this._escape(this._config.title)}</h2>
              <p>${this._escape(statusText)}</p>
            </div>
            <span class="${offlineCount ? "badge bad" : "badge good"}">
              ${offlineCount ? "Attention needed" : "All clear"}
            </span>
          </header>

          <section class="filters">
            ${this._select("status", "Status", this._statusOptions())}
            ${this._select("displayMode", "Card style", [
              ["detailed", "Detailed"],
              ["simple", "Simple"],
            ])}
            ${this._multiChoice("domains", "Domains", "All domains", this._options(allRows, "domains"))}
            ${this._multiChoice("integrations", "Integrations", "All integrations", this._options(allRows, "integrations"))}
            ${this._multiChoice("areas", "Areas", "All areas", this._options(allRows, "areaName"))}
            <label class="search">
              <span>Search</span>
              <input data-filter="search" value="${this._escape(this._filters.search)}" placeholder="Device, entity, area..." />
            </label>
          </section>

          ${rows.length ? this._areasTemplate(rows) : this._emptyTemplate(allRows.length)}
        </div>
      </ha-card>
      ${this._styles()}
    `;

    this.shadowRoot.querySelectorAll("[data-filter]").forEach((element) => {
      element.addEventListener("input", (event) => {
        this._filters[event.target.dataset.filter] = event.target.value;
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-filter-multi]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.target.dataset.filterMulti;
        this._openMulti = key;
        const value = event.target.value;
        const selected = new Set(this._filters[key]);
        if (event.target.checked) selected.add(value);
        else selected.delete(value);
        this._filters[key] = [...selected].sort((a, b) => a.localeCompare(b));
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-clear-multi]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        const key = event.currentTarget.dataset.clearMulti;
        this._openMulti = key;
        this._filters[key] = [];
        this._saveFilters();
        this._render({ preserveScroll: true });
      });
    });

    this.shadowRoot.querySelectorAll("[data-multi-details]").forEach((element) => {
      element.addEventListener("toggle", (event) => {
        const key = event.currentTarget.dataset.multiDetails;
        this._openMulti = event.currentTarget.open ? key : null;
      });
    });

    this.shadowRoot.querySelectorAll("[data-entity]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const entityId = event.currentTarget.dataset.entity;
        const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
        moreInfoEvent.detail = { entityId };
        this.dispatchEvent(moreInfoEvent);
      });
    });

    if (preserveScroll) {
      requestAnimationFrame(() => {
        this._restoreScroll(scrollSnapshots);
        if (this._openMulti) {
          const restoredMenu = this.shadowRoot.querySelector(`[data-multi-menu="${this._openMulti}"]`);
          if (restoredMenu) restoredMenu.scrollTo(menuScrollLeft, menuScrollTop);
        }
      });
    }
  }

  _scrollSnapshots() {
    const snapshots = [];
    const seen = new Set();
    const add = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      snapshots.push({
        element,
        left: element.scrollLeft,
        top: element.scrollTop,
      });
    };

    add(document.scrollingElement || document.documentElement);

    let node = this;
    while (node) {
      if (node instanceof Element) {
        const style = getComputedStyle(node);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
        if (canScrollY || canScrollX) add(node);
      }

      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
    }

    return snapshots;
  }

  _restoreScroll(snapshots) {
    for (const snapshot of snapshots) {
      snapshot.element.scrollTo(snapshot.left, snapshot.top);
    }
  }

  _statusOptions() {
    const options = [["offline", "Offline"]];
    if (this._config.show_online !== false) {
      options.push(["online", "Online"], ["all", "All"]);
    }
    return options;
  }

  _select(key, label, options) {
    const optionHtml = options
      .map(([value, text]) => `<option value="${this._escape(value)}" ${this._filters[key] === value ? "selected" : ""}>${this._escape(text)}</option>`)
      .join("");

    return `
      <label>
        <span>${this._escape(label)}</span>
        <select data-filter="${this._escape(key)}">${optionHtml}</select>
      </label>
    `;
  }

  _multiChoice(key, label, allText, options) {
    const selected = this._filters[key] || [];
    const summary = selected.length ? `${selected.length} selected` : allText;
    const optionHtml = options.length
      ? options
          .map(
            (value) => `
              <label class="check-row">
                <input
                  type="checkbox"
                  data-filter-multi="${this._escape(key)}"
                  value="${this._escape(value)}"
                  ${selected.includes(value) ? "checked" : ""}
                />
                <span>${this._escape(value)}</span>
              </label>
            `
          )
          .join("")
      : `<div class="no-options">No options</div>`;

    return `
      <div class="multi">
        <span class="filter-label">${this._escape(label)}</span>
        <details data-multi-details="${this._escape(key)}" ${this._openMulti === key ? "open" : ""}>
          <summary>${this._escape(summary)}</summary>
          <div class="multi-menu" data-multi-menu="${this._escape(key)}">
            <button type="button" class="clear" data-clear-multi="${this._escape(key)}">${this._escape(allText)}</button>
            ${optionHtml}
          </div>
        </details>
      </div>
    `;
  }

  _areasTemplate(rows) {
    return [...this._groupByArea(rows).entries()]
      .map(([area, areaRows]) => {
        const offline = areaRows.filter((row) => row.offline).length;
        return `
          <section class="area">
            <div class="area-title">
              <h3>${this._escape(area)}</h3>
              <span>${offline} offline / ${areaRows.length} shown</span>
            </div>
            <div class="grid">
              ${areaRows.map((row) => this._deviceTemplate(row)).join("")}
            </div>
          </section>
        `;
      })
      .join("");
  }

  _deviceTemplate(row) {
    const changed = row.lastChanged ? new Date(row.lastChanged).toLocaleString() : "Unknown";
    const stateLabel = row.offline ? "Offline" : "Online";
    const simple = this._filters.displayMode === "simple";

    return `
      <button class="device ${simple ? "simple" : "detailed"} ${row.offline ? "offline" : "online"}" data-entity="${this._escape(row.entityId)}">
        <span class="frame"></span>
        <span class="topline">
          <span class="name">${this._escape(row.name)}</span>
          <span class="pill">${this._escape(stateLabel)}</span>
        </span>
        ${
          simple
            ? `<span class="simple-meta">${this._escape(row.domain || row.integration)}</span>`
            : `
        <span class="meta">${row.offlineEntities.length ? this._offlineEntityDetails(row.offlineEntities) : this._escape(`${row.entityCount} entities`)}</span>
              <span class="details">
                <span>${this._escape(row.domain)}</span>
                <span>${this._escape(row.integration)}</span>
                <span>${this._escape(row.offlineEntities.length ? `${row.offlineEntities.length} offline` : row.state)}</span>
              </span>
              <span class="changed">Changed: ${this._escape(changed)}</span>
            `
        }
      </button>
    `;
  }

  _offlineEntityDetails(entities) {
    return entities
      .map((entity) => {
        const unique = entity.uniqueId ? ` (${entity.uniqueId})` : "";
        return `<span class="entity-detail">${this._escape(entity.name)}${this._escape(unique)}</span>`;
      })
      .join("");
  }

  _emptyTemplate(total) {
    const text = total ? "No devices match the current filters." : "No entities are available yet.";
    return `<div class="empty">${this._escape(text)}</div>`;
  }

  _escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _styles() {
    return `
      <style>
        :host {
          display: block;
          --odp-good: #1d8f5f;
          --odp-good-soft: rgba(29, 143, 95, 0.12);
          --odp-bad: #d43636;
          --odp-bad-soft: rgba(212, 54, 54, 0.14);
          --odp-border: var(--divider-color, rgba(127, 127, 127, 0.24));
          --odp-card: var(--card-background-color, #fff);
          --odp-muted: var(--secondary-text-color, #667085);
        }

        .panel {
          padding: 18px;
        }

        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 16px;
        }

        h2, h3, p {
          margin: 0;
        }

        h2 {
          color: var(--primary-text-color);
          font-size: 22px;
          font-weight: 650;
          line-height: 1.2;
        }

        p, .area-title span, .meta, .details, .changed, label span, .filter-label, .simple-meta {
          color: var(--odp-muted);
        }

        .badge {
          border: 1px solid currentColor;
          border-radius: 999px;
          font-size: 13px;
          font-weight: 650;
          padding: 7px 11px;
          white-space: nowrap;
        }

        .badge.good {
          color: var(--odp-good);
          background: var(--odp-good-soft);
        }

        .badge.bad {
          color: var(--odp-bad);
          background: var(--odp-bad-soft);
        }

        .filters {
          display: grid;
          grid-template-columns: repeat(6, minmax(130px, 1fr));
          gap: 10px;
          margin-bottom: 18px;
        }

        label, .multi {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        label span, .filter-label {
          font-size: 12px;
          font-weight: 650;
        }

        select, input, summary {
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: inherit;
          min-height: 40px;
          padding: 0 10px;
        }

        details {
          position: relative;
        }

        summary {
          display: flex;
          align-items: center;
          cursor: pointer;
          list-style: none;
        }

        summary::-webkit-details-marker {
          display: none;
        }

        summary::after {
          content: "v";
          margin-left: auto;
          font-size: 18px;
          line-height: 1;
        }

        details[open] summary {
          border-color: var(--primary-color, #03a9f4);
        }

        .multi-menu {
          position: absolute;
          z-index: 3;
          inset: calc(100% + 5px) 0 auto 0;
          display: grid;
          gap: 2px;
          max-height: 260px;
          overflow: auto;
          border: 1px solid var(--odp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 14px 28px rgba(0, 0, 0, 0.22);
          padding: 6px;
        }

        .check-row {
          display: flex;
          align-items: center;
          gap: 8px;
          border-radius: 6px;
          cursor: pointer;
          min-height: 34px;
          padding: 0 8px;
        }

        .check-row:hover, .clear:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .check-row input {
          width: 16px;
          min-height: 16px;
          padding: 0;
        }

        .check-row span {
          min-width: 0;
          overflow-wrap: anywhere;
          color: var(--primary-text-color);
          font-size: 13px;
          font-weight: 500;
        }

        .clear {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          min-height: 34px;
          padding: 0 8px;
          text-align: left;
        }

        .no-options {
          color: var(--odp-muted);
          font-size: 13px;
          padding: 8px;
        }

        .area + .area {
          margin-top: 20px;
        }

        .area-title {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
        }

        h3 {
          color: var(--primary-text-color);
          font-size: 16px;
          font-weight: 700;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
          gap: 10px;
        }

        .device {
          position: relative;
          display: grid;
          gap: 8px;
          min-height: 138px;
          text-align: left;
          border: 2px solid var(--odp-border);
          border-radius: 8px;
          padding: 13px;
          background: var(--odp-card);
          color: var(--primary-text-color);
          cursor: pointer;
          overflow: hidden;
        }

        .device.simple {
          align-content: center;
          gap: 7px;
          min-height: 88px;
        }

        .device.offline {
          border-color: var(--odp-bad);
          box-shadow: inset 0 0 0 1px rgba(212, 54, 54, 0.2);
        }

        .device.online {
          border-color: var(--odp-good);
          box-shadow: inset 0 0 0 1px rgba(29, 143, 95, 0.18);
        }

        .frame {
          position: absolute;
          inset: 0 auto 0 0;
          width: 7px;
          background: var(--odp-good);
        }

        .offline .frame {
          background: var(--odp-bad);
        }

        .topline, .details {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .topline {
          justify-content: space-between;
        }

        .name {
          min-width: 0;
          overflow-wrap: anywhere;
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
        }

        .pill {
          flex: 0 0 auto;
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 12px;
          font-weight: 700;
          color: #fff;
          background: var(--odp-good);
        }

        .offline .pill {
          background: var(--odp-bad);
        }

        .meta {
          display: grid;
          gap: 3px;
          overflow-wrap: anywhere;
          font-size: 12px;
        }

        .entity-detail {
          display: block;
        }

        .details {
          flex-wrap: wrap;
          font-size: 12px;
        }

        .details span {
          border: 1px solid var(--odp-border);
          border-radius: 999px;
          padding: 3px 7px;
        }

        .changed {
          align-self: end;
          font-size: 12px;
        }

        .simple-meta {
          overflow-wrap: anywhere;
          font-size: 12px;
        }

        .empty {
          border: 1px dashed var(--odp-border);
          border-radius: 8px;
          color: var(--odp-muted);
          padding: 28px;
          text-align: center;
        }

        @media (max-width: 760px) {
          .panel {
            padding: 14px;
          }

          header, .area-title {
            align-items: flex-start;
            flex-direction: column;
          }

          .filters {
            grid-template-columns: 1fr;
          }

          .grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
    `;
  }
}

customElements.define("offline-device-panel", OfflineDevicePanel);

class OfflineDevicePanelEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this.innerHTML = `
      <div style="padding: 12px; color: var(--primary-text-color);">
        Configure this card in YAML for domain, integration, area, and offline state filters.
      </div>
    `;
  }
}

customElements.define("offline-device-panel-editor", OfflineDevicePanelEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "offline-device-panel",
  name: "Offline Device Panel",
  description: "Filterable Home Assistant device status panel grouped by area.",
});
