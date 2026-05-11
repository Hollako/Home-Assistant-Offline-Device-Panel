class DeviceMapPanel extends HTMLElement {
  static getConfigElement() {
    return document.createElement("device-map-panel-editor");
  }

  static getStubConfig() {
    return {
      title: "Device Map",
      image: "/local/floorplan.png",
      offline_states: ["unavailable", "unknown"],
      markers: [],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._registriesLoaded = false;
    this._entities = [];
    this._devices = [];
    this._areas = [];
    this._markers = {};
    this._filters = {
      status: "all",
      domain: "all",
      integration: "all",
      area: "all",
      search: "",
    };
    this._mode = "user";
    this._zoom = 1;
    this._exportOpen = false;
    this._display = {
      markerSize: 18,
      showLabels: true,
    };
    this._mapScroll = {
      left: 0,
      top: 0,
    };
    this._isPanning = false;
  }

  setConfig(config) {
    this._config = {
      title: "Device Map",
      image: "",
      offline_states: ["unavailable", "unknown"],
      domains: [],
      integrations: [],
      areas: [],
      markers: [],
      persist_layout: true,
      storage_key: "",
      marker_size: 18,
      show_labels: true,
      ...config,
    };
    this._display = this._normalizedDisplay({
      markerSize: this._config.marker_size,
      showLabels: this._config.show_labels,
      ...this._loadDisplay(),
    });
    this._markers = this._normalizedMarkers({
      ...this._configMarkers(),
      ...this._loadMarkers(),
    });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._loadRegistries(hass);
    if (this._isControlActive()) return;
    this._render();
  }

  getCardSize() {
    return 8;
  }

  _canEdit() {
    return this._hass?.user?.is_admin === true;
  }

  _isControlActive() {
    const active = this.shadowRoot?.activeElement;
    return this._isPanning || ["INPUT", "SELECT", "TEXTAREA"].includes(active?.tagName);
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
      if (this._isControlActive()) return;
      this._render();
    } catch (error) {
      console.warn("device-map-panel: registry lookup failed", error);
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
          icons: new Set(),
          deviceClasses: new Set(),
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
      if (stateObj.attributes?.icon) row.icons.add(stateObj.attributes.icon);
      if (stateObj.attributes?.device_class) row.deviceClasses.add(stateObj.attributes.device_class);
      row.entityCount += 1;
      if (isOffline) {
        row.offlineEntities.push({
          entityId,
          name: stateObj.attributes?.friendly_name || entity?.name || entityId,
        });
      }
      if (isOffline || !row.lastChanged || new Date(stateObj.last_changed) > new Date(row.lastChanged)) {
        row.lastChanged = stateObj.last_changed;
      }
    }

    return [...grouped.values()]
      .map((row) => {
        const domains = [...row.domains].sort((a, b) => a.localeCompare(b));
        const integrations = [...row.integrations].sort((a, b) => a.localeCompare(b));
        const states = [...row.states].sort((a, b) => a.localeCompare(b));
        const icons = [...row.icons].sort((a, b) => a.localeCompare(b));
        const deviceClasses = [...row.deviceClasses].sort((a, b) => a.localeCompare(b));
        return {
          ...row,
          entityId: row.offlineEntities[0]?.entityId || row.entityId,
          domain: domains.join(", "),
          integration: integrations.join(", "),
          state: states.join(", "),
          domains,
          integrations,
          states,
          icons,
          deviceClasses,
        };
      })
      .sort((a, b) => a.areaName.localeCompare(b.areaName) || a.name.localeCompare(b.name));
  }

  _integration(entity, stateObj) {
    if (entity?.platform) return entity.platform;
    const attr = stateObj.attributes || {};
    return attr.integration || attr.platform || "unknown";
  }

  _isOffline(state) {
    return this._config.offline_states.includes(String(state).toLowerCase());
  }

  _iconOptions() {
    return [
      ["auto", "Auto"],
      ["mdi:lightbulb", "Light"],
      ["mdi:motion-sensor", "Motion"],
      ["mdi:door", "Door"],
      ["mdi:window-closed", "Window"],
      ["mdi:power-socket", "Switch/Plug"],
      ["mdi:thermostat", "Climate"],
      ["mdi:thermometer", "Temperature"],
      ["mdi:water-percent", "Humidity"],
      ["mdi:smoke-detector", "Smoke"],
      ["mdi:cctv", "Camera"],
      ["mdi:lock", "Lock"],
      ["mdi:garage", "Garage"],
      ["mdi:blinds", "Cover"],
      ["mdi:speaker", "Media"],
      ["mdi:wifi", "Network"],
      ["mdi:battery", "Battery"],
      ["mdi:home-alert", "Alert"],
      ["mdi:devices", "Device"],
    ];
  }

  _markerIcon(row) {
    const markerIcon = this._markers[row.key]?.icon;
    if (markerIcon) return markerIcon;
    return this._defaultIcon(row);
  }

  _defaultIcon(row) {
    const deviceClass = row.deviceClasses[0];
    if (deviceClass) {
      const classIcons = {
        motion: "mdi:motion-sensor",
        occupancy: "mdi:motion-sensor",
        door: "mdi:door",
        window: "mdi:window-closed",
        garage_door: "mdi:garage",
        opening: "mdi:door-open",
        smoke: "mdi:smoke-detector",
        gas: "mdi:gas-cylinder",
        moisture: "mdi:water-alert",
        temperature: "mdi:thermometer",
        humidity: "mdi:water-percent",
        illuminance: "mdi:brightness-5",
        battery: "mdi:battery",
        power: "mdi:flash",
        energy: "mdi:lightning-bolt",
        voltage: "mdi:sine-wave",
        current: "mdi:current-ac",
        plug: "mdi:power-plug",
        lock: "mdi:lock",
      };
      if (classIcons[deviceClass]) return classIcons[deviceClass];
    }

    if (row.icons[0]) return row.icons[0];

    const domainIcons = {
      light: "mdi:lightbulb",
      switch: "mdi:toggle-switch",
      sensor: "mdi:eye",
      binary_sensor: "mdi:checkbox-marked-circle-outline",
      climate: "mdi:thermostat",
      cover: "mdi:blinds",
      lock: "mdi:lock",
      camera: "mdi:cctv",
      media_player: "mdi:speaker",
      fan: "mdi:fan",
      vacuum: "mdi:robot-vacuum",
      alarm_control_panel: "mdi:shield-home",
      device_tracker: "mdi:map-marker",
      person: "mdi:account",
      button: "mdi:gesture-tap-button",
      scene: "mdi:palette",
      script: "mdi:script-text",
      automation: "mdi:home-automation",
    };

    return domainIcons[row.domains[0]] || "mdi:devices";
  }

  _filteredRows(rows) {
    const search = this._filters.search.trim().toLowerCase();
    return rows.filter((row) => {
      if (this._filters.status === "placed" && !this._markers[row.key]) return false;
      if (this._filters.status === "unplaced" && this._markers[row.key]) return false;
      if (this._filters.status === "offline" && !row.offline) return false;
      if (this._filters.status === "online" && row.offline) return false;
      if (this._filters.domain !== "all" && !row.domains.includes(this._filters.domain)) return false;
      if (this._filters.integration !== "all" && !row.integrations.includes(this._filters.integration)) return false;
      if (this._filters.area !== "all" && row.areaName !== this._filters.area) return false;
      if (!search) return true;

      const haystack = `${row.name} ${row.entityId} ${row.areaName} ${row.domain} ${row.integration}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  _options(rows, key) {
    const values = rows.flatMap((row) => {
      const value = row[key];
      return Array.isArray(value) ? value : [value];
    });
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _configMarkers() {
    return (this._config.markers || []).reduce((markers, marker) => {
      const key = marker.key || marker.device || marker.entity;
      if (!key) return markers;
      markers[key] = {
        key,
        entityId: marker.entity || "",
        name: marker.name || "",
        icon: marker.icon || "",
        x: Number(marker.x),
        y: Number(marker.y),
      };
      return markers;
    }, {});
  }

  _normalizedMarkers(markers) {
    return Object.entries(markers || {}).reduce((result, [key, marker]) => {
      const x = Number(marker.x);
      const y = Number(marker.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return result;
      result[key] = {
        key,
        entityId: marker.entityId || marker.entity || "",
        name: marker.name || "",
        icon: marker.icon || "",
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
      };
      return result;
    }, {});
  }

  _storageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "device-map-panel";
    return `device-map-panel:markers:${path}:${cardKey}`;
  }

  _displayStorageKey() {
    const path = window.location?.pathname || "dashboard";
    const cardKey = this._config.storage_key || this._config.title || "device-map-panel";
    return `device-map-panel:display:${path}:${cardKey}`;
  }

  _loadMarkers() {
    if (this._config.persist_layout === false) return {};

    try {
      const value = localStorage.getItem(this._storageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("device-map-panel: saved marker layout could not be loaded", error);
      return {};
    }
  }

  _saveMarkers() {
    if (this._config.persist_layout === false) return;

    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this._markers));
    } catch (error) {
      console.warn("device-map-panel: marker layout could not be saved", error);
    }
  }

  _loadDisplay() {
    if (this._config.persist_layout === false) return {};

    try {
      const value = localStorage.getItem(this._displayStorageKey());
      return value ? JSON.parse(value) : {};
    } catch (error) {
      console.warn("device-map-panel: display settings could not be loaded", error);
      return {};
    }
  }

  _saveDisplay() {
    if (this._config.persist_layout === false) return;

    try {
      localStorage.setItem(this._displayStorageKey(), JSON.stringify(this._display));
    } catch (error) {
      console.warn("device-map-panel: display settings could not be saved", error);
    }
  }

  _normalizedDisplay(display) {
    const markerSize = Number(display.markerSize);
    return {
      markerSize: Number.isFinite(markerSize) ? Math.max(12, Math.min(48, markerSize)) : 18,
      showLabels: display.showLabels !== false && display.showLabels !== "false",
    };
  }

  _render() {
    if (!this.shadowRoot) return;

    this._captureMapScroll();

    const rows = this._deviceRows();
    const filteredRows = this._filteredRows(rows);
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const placedRows = Object.keys(this._markers)
      .map((key) => rowByKey.get(key))
      .filter(Boolean);
    const offlineCount = placedRows.filter((row) => row.offline).length;
    const canEdit = this._canEdit();
    const isEditing = canEdit && this._mode === "edit";
    const modeLabel = isEditing ? "Edit Mode" : "User Mode";

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="panel ${isEditing ? "editing" : "viewing"}">
          ${
            isEditing
              ? `
          <aside>
            <header>
              <div>
                <h2>${this._escape(this._config.title)}</h2>
                <p>${this._escape(modeLabel)} - ${placedRows.length} placed / ${offlineCount} offline</p>
              </div>
            </header>
            <section class="filters">
              ${this._select("status", "Status", [
                ["all", "All devices"],
                ["placed", "Placed"],
                ["unplaced", "Unplaced"],
                ["offline", "Offline"],
                ["online", "Online"],
              ])}
              ${this._select("domain", "Domain", [["all", "All domains"], ...this._options(rows, "domains").map((value) => [value, value])])}
              ${this._select("integration", "Integration", [["all", "All integrations"], ...this._options(rows, "integrations").map((value) => [value, value])])}
              ${this._select("area", "Area", [["all", "All areas"], ...this._options(rows, "areaName").map((value) => [value, value])])}
              <label>
                <span>Search</span>
                <input data-filter="search" value="${this._escape(this._filters.search)}" placeholder="Device, entity, area..." />
              </label>
            </section>
            <section class="devices">
              ${filteredRows.map((row) => this._deviceListItem(row)).join("") || `<div class="empty-list">No devices match</div>`}
            </section>
            <details class="export" data-export ${this._exportOpen ? "open" : ""}>
              <summary>Export YAML</summary>
              <textarea readonly>${this._escape(this._yamlExport(rows))}</textarea>
            </details>
          </aside>
          `
              : ""
          }
          <main>
            <div class="map-toolbar">
              <div class="toolbar-title">${this._escape(this._config.title)}</div>
              <div class="zoom-controls" aria-label="Map zoom">
                <button type="button" data-zoom="out" title="Zoom out">-</button>
                <span>${Math.round(this._zoom * 100)}%</span>
                <button type="button" data-zoom="in" title="Zoom in">+</button>
                <button type="button" data-zoom="reset" title="Reset zoom">Reset</button>
              </div>
              <div class="display-controls" aria-label="Marker display">
                <label title="Marker size">
                  <span>Size</span>
                  <input data-display="markerSize" type="range" min="12" max="48" step="2" value="${this._escape(this._display.markerSize)}" />
                </label>
                <label class="toolbar-toggle" title="Show marker names">
                  <input data-display="showLabels" type="checkbox" ${this._display.showLabels ? "checked" : ""} />
                  <span>Names</span>
                </label>
              </div>
              ${
                canEdit
                  ? `
              <div class="mode-switch" aria-label="Map mode">
                <button type="button" data-mode="user" class="${!isEditing ? "active" : ""}">User Mode</button>
                <button type="button" data-mode="edit" class="${isEditing ? "active" : ""}">Edit Mode</button>
              </div>
              `
                  : ""
              }
            </div>
            ${
              this._config.image
                ? `
            <div class="map ${isEditing ? "editable" : ""} ${this._zoom < 1 ? "zoomed-out" : ""}" data-map>
              <div class="map-content" style="width: ${this._escape(this._zoom * 100)}%;">
                <img src="${this._escape(this._config.image)}" alt="" />
                <div class="image-error">Image could not be loaded: ${this._escape(this._config.image)}</div>
                ${placedRows.map((row) => this._markerTemplate(row, isEditing)).join("")}
              </div>
            </div>
            `
                : `<div class="missing-image">Add an image URL in the card YAML.</div>`
            }
          </main>
        </div>
      </ha-card>
      ${this._styles()}
    `;

    this._attachEvents();
    requestAnimationFrame(() => this._restoreMapScroll());
  }

  _attachEvents() {
    const isEditing = this._canEdit() && this._mode === "edit";

    this.shadowRoot.querySelectorAll("[data-mode]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._mode = event.currentTarget.dataset.mode === "edit" ? "edit" : "user";
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-zoom]").forEach((element) => {
      element.addEventListener("click", (event) => {
        const action = event.currentTarget.dataset.zoom;
        if (action === "reset") this._zoom = 1;
        if (action === "in") this._zoom = Math.min(4, Math.round((this._zoom + 0.1) * 10) / 10);
        if (action === "out") this._zoom = Math.max(0.5, Math.round((this._zoom - 0.1) * 10) / 10);
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-display]").forEach((element) => {
      element.addEventListener("input", (event) => {
        const key = event.currentTarget.dataset.display;
        if (key === "markerSize") this._display.markerSize = Number(event.currentTarget.value);
        if (key === "showLabels") this._display.showLabels = event.currentTarget.checked;
        this._display = this._normalizedDisplay(this._display);
        this._saveDisplay();
        this._render();
      });
    });

    const map = this.shadowRoot.querySelector("[data-map]");
    if (map) {
      map.addEventListener("scroll", () => this._captureMapScroll());
      const image = map.querySelector("img");
      if (image) {
        image.addEventListener("error", () => {
          map.classList.add("image-failed");
        });
        image.addEventListener("load", () => {
          map.classList.remove("image-failed");
        });
      }
      this._attachPanEvents(map);
    }

    if (!isEditing) {
      this.shadowRoot.querySelectorAll("[data-marker]").forEach((element) => {
        element.addEventListener("click", (event) => {
          const entityId = event.currentTarget.dataset.entity;
          if (!entityId) return;
          const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
          moreInfoEvent.detail = { entityId };
          this.dispatchEvent(moreInfoEvent);
        });
      });
      return;
    }

    this.shadowRoot.querySelectorAll("[data-filter]").forEach((element) => {
      element.addEventListener("input", (event) => {
        this._filters[event.target.dataset.filter] = event.target.value;
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-device]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", event.currentTarget.dataset.device);
        event.dataTransfer.effectAllowed = "copyMove";
      });
    });

    this.shadowRoot.querySelectorAll("[data-remove]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        delete this._markers[event.currentTarget.dataset.remove];
        this._saveMarkers();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-export]").forEach((element) => {
      element.addEventListener("toggle", (event) => {
        this._exportOpen = event.currentTarget.open;
      });
    });

    this.shadowRoot.querySelectorAll("[data-icon]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const key = event.currentTarget.dataset.icon;
        if (!this._markers[key]) return;
        const value = event.currentTarget.value;
        this._markers[key].icon = value === "auto" ? "" : value;
        this._saveMarkers();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-marker]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", event.currentTarget.dataset.marker);
        event.dataTransfer.effectAllowed = "move";
      });
      element.addEventListener("click", (event) => {
        const entityId = event.currentTarget.dataset.entity;
        if (!entityId) return;
        const moreInfoEvent = new Event("hass-more-info", { bubbles: true, composed: true });
        moreInfoEvent.detail = { entityId };
        this.dispatchEvent(moreInfoEvent);
      });
    });

    if (map) {
      map.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      map.addEventListener("drop", (event) => {
        event.preventDefault();
        const key = event.dataTransfer.getData("text/plain");
        const row = this._deviceRows().find((item) => item.key === key);
        if (!row) return;

        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        this._markers[key] = {
          key,
          entityId: row.entityId,
          name: row.name,
          icon: this._markers[key]?.icon || "",
          x: point.x,
          y: point.y,
        };
        this._saveMarkers();
        this._render();
      });
    }
  }

  _pointFromEvent(element, event) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  }

  _captureMapScroll() {
    const map = this.shadowRoot?.querySelector("[data-map]");
    if (!map) return;
    this._mapScroll = {
      left: map.scrollLeft,
      top: map.scrollTop,
    };
  }

  _restoreMapScroll() {
    const map = this.shadowRoot?.querySelector("[data-map]");
    if (!map) return;
    map.scrollLeft = this._mapScroll.left;
    map.scrollTop = this._mapScroll.top;
  }

  _attachPanEvents(map) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let panning = false;
    let pointerId = null;

    map.addEventListener("pointerdown", (event) => {
      const canScrollX = map.scrollWidth > map.clientWidth;
      const canScrollY = map.scrollHeight > map.clientHeight;
      if (!canScrollX && !canScrollY) return;
      if (event.target.closest("[data-marker]")) return;
      if (event.button !== undefined && event.button !== 0) return;

      event.preventDefault();
      panning = true;
      pointerId = event.pointerId;
      this._isPanning = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = map.scrollLeft;
      startTop = map.scrollTop;
      map.classList.add("panning");
      map.setPointerCapture?.(event.pointerId);
    });

    const movePan = (event) => {
      if (!panning) return;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      event.preventDefault();
      map.scrollLeft = startLeft - (event.clientX - startX);
      map.scrollTop = startTop - (event.clientY - startY);
      this._captureMapScroll();
    };

    map.addEventListener("pointermove", movePan);

    const stopPan = (event) => {
      if (!panning) return;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      panning = false;
      pointerId = null;
      this._isPanning = false;
      this._captureMapScroll();
      map.classList.remove("panning");
      map.releasePointerCapture?.(event.pointerId);
    };

    map.addEventListener("pointerup", stopPan);
    map.addEventListener("pointercancel", stopPan);
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

  _deviceListItem(row) {
    const placed = Boolean(this._markers[row.key]);
    const icon = this._markerIcon(row);
    return `
      <div class="device-row ${row.offline ? "offline" : "online"}" draggable="true" data-device="${this._escape(row.key)}">
        <span class="dot"><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        <span class="device-text">
          <strong>${this._escape(row.name)}</strong>
          <small>${this._escape(row.areaName)} - ${this._escape(row.domain || row.integration)}</small>
          ${placed ? this._iconSelect(row) : ""}
        </span>
        ${
          placed
            ? `<button type="button" class="remove" data-remove="${this._escape(row.key)}" title="Remove from map">Remove</button>`
            : `<span class="placed">Drag</span>`
        }
      </div>
    `;
  }

  _iconSelect(row) {
    const selected = this._markers[row.key]?.icon || "auto";
    const options = this._iconOptions()
      .map(([value, label]) => `<option value="${this._escape(value)}" ${selected === value ? "selected" : ""}>${this._escape(label)}</option>`)
      .join("");

    return `
      <label class="icon-picker">
        <span>Icon</span>
        <select data-icon="${this._escape(row.key)}">${options}</select>
      </label>
    `;
  }

  _markerTemplate(row, isEditing) {
    const marker = this._markers[row.key];
    const size = this._display.markerSize;
    const icon = this._markerIcon(row);
    return `
      <button
        class="marker ${this._display.showLabels ? "with-label" : "icon-only"} ${row.offline ? "offline" : "online"}"
        style="left: ${this._escape(marker.x)}%; top: ${this._escape(marker.y)}%; --marker-size: ${this._escape(size)}px;"
        draggable="${isEditing ? "true" : "false"}"
        data-marker="${this._escape(row.key)}"
        data-entity="${this._escape(row.entityId)}"
        title="${this._escape(row.name)}"
      >
        <span><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        ${this._display.showLabels ? `<strong>${this._escape(row.name)}</strong>` : ""}
      </button>
    `;
  }

  _yamlExport(rows) {
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const markers = Object.entries(this._markers)
      .map(([key, marker]) => {
        const row = rowByKey.get(key);
        return {
          key,
          entity: row?.entityId || marker.entityId,
          name: row?.name || marker.name || key,
          icon: marker.icon || "",
          x: Number(marker.x).toFixed(2),
          y: Number(marker.y).toFixed(2),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!markers.length) return "markers: []";

    return [
      "markers:",
      ...markers.flatMap((marker) => [
        `  - key: ${marker.key}`,
        `    entity: ${marker.entity}`,
        `    name: ${marker.name}`,
        ...(marker.icon ? [`    icon: ${marker.icon}`] : []),
        `    x: ${marker.x}`,
        `    y: ${marker.y}`,
      ]),
    ].join("\n");
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
          --dmp-good: #1d8f5f;
          --dmp-bad: #d43636;
          --dmp-border: var(--divider-color, rgba(127, 127, 127, 0.24));
          --dmp-muted: var(--secondary-text-color, #667085);
        }

        .panel {
          display: grid;
          grid-template-columns: minmax(260px, 330px) 1fr;
        }

        .panel.viewing {
          display: block;
        }

        aside {
          display: grid;
          grid-template-rows: auto auto 1fr auto;
          gap: 12px;
          min-width: 0;
          border-right: 1px solid var(--dmp-border);
          padding: 14px;
        }

        header h2, header p {
          margin: 0;
        }

        header h2 {
          color: var(--primary-text-color);
          font-size: 20px;
          font-weight: 700;
          line-height: 1.2;
        }

        header p {
          color: var(--dmp-muted);
          font-size: 13px;
          margin-top: 4px;
        }

        .filters {
          display: grid;
          gap: 8px;
        }

        label {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        label span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
        }

        select, input {
          box-sizing: border-box;
          width: 100%;
          min-height: 38px;
          min-width: 0;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: inherit;
          padding: 0 10px;
        }

        input[type="range"] {
          padding: 0;
        }

        input[type="checkbox"] {
          width: 16px;
          min-height: 16px;
          padding: 0;
        }

        .toggle-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .toggle-row span {
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .devices {
          display: grid;
          align-content: start;
          gap: 7px;
          min-height: 0;
          overflow: auto;
          padding-right: 2px;
        }

        .device-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 9px;
          min-height: 48px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          cursor: grab;
          padding: 8px;
        }

        .device-row:active {
          cursor: grabbing;
        }

        .dot, .marker span {
          display: grid;
          place-items: center;
          border-radius: 999px;
          background: var(--dmp-good);
          color: #fff;
        }

        .offline .dot, .marker.offline span {
          background: var(--dmp-bad);
        }

        .dot {
          width: 28px;
          height: 28px;
        }

        .dot ha-icon {
          --mdc-icon-size: 18px;
        }

        .device-text {
          display: grid;
          gap: 2px;
          min-width: 0;
        }

        .device-text strong, .device-text small {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .device-text strong {
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .device-text small, .placed, .empty-list {
          color: var(--dmp-muted);
          font-size: 12px;
        }

        .icon-picker {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 6px;
          margin-top: 3px;
        }

        .icon-picker span {
          color: var(--dmp-muted);
          font-size: 11px;
          font-weight: 700;
        }

        .icon-picker select {
          min-height: 28px;
          font-size: 12px;
          padding: 0 7px;
        }

        .placed, .remove {
          border: 1px solid var(--dmp-border);
          border-radius: 999px;
          padding: 3px 7px;
        }

        .remove {
          background: transparent;
          color: var(--dmp-muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
        }

        .remove:hover {
          color: var(--dmp-bad);
          border-color: var(--dmp-bad);
        }

        main {
          position: relative;
          min-width: 0;
          padding: 14px;
        }

        .viewing main {
          padding: 0 0 14px;
        }

        .map-toolbar {
          position: sticky;
          z-index: 4;
          top: 12px;
          display: grid;
          grid-template-columns: minmax(160px, 1fr) auto minmax(220px, 1fr) auto;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          width: calc(100% - 24px);
          max-width: calc(100% - 24px);
          margin: 12px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 3px 12px rgba(0, 0, 0, 0.18);
          padding: 4px;
        }

        .toolbar-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--primary-text-color);
          font-size: 14px;
          font-weight: 800;
          padding: 0 10px;
        }

        .mode-switch {
          display: flex;
          gap: 4px;
        }

        .mode-switch button {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--dmp-muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          padding: 0 10px;
        }

        .mode-switch button.active {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
        }

        .zoom-controls {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .zoom-controls button {
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          min-width: 30px;
          padding: 0 8px;
        }

        .zoom-controls button:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .zoom-controls span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
          min-width: 42px;
          text-align: center;
        }

        .display-controls {
          display: flex;
          align-items: center;
          gap: 12px;
          width: auto;
          min-width: 220px;
          border-left: 1px solid var(--dmp-border);
          border-right: 1px solid var(--dmp-border);
          margin-left: 4px;
          padding: 0 10px;
        }

        .display-controls label {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .display-controls span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
        }

        .display-controls input[type="range"] {
          min-height: 20px;
          min-width: 90px;
        }

        .display-controls .toolbar-toggle {
          grid-template-columns: auto auto;
          justify-content: start;
          white-space: nowrap;
        }

        .map {
          position: relative;
          width: 100%;
          max-height: clamp(520px, 82vh, 1100px);
          overflow: auto;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          cursor: grab;
          touch-action: none;
        }

        .map.panning {
          cursor: grabbing;
          user-select: none;
        }

        .map-content {
          position: relative;
          margin: 0;
        }

        .zoomed-out .map-content {
          margin: 0 auto;
        }

        .viewing .map {
          border: 0;
          border-radius: var(--ha-card-border-radius, 12px);
        }

        .map img {
          display: block;
          width: 100%;
          height: auto;
          object-fit: contain;
          pointer-events: none;
          user-select: none;
        }

        .image-error {
          display: none;
          position: absolute;
          inset: 16px;
          place-items: center;
          border: 1px dashed var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          color: var(--dmp-muted);
          padding: 18px;
          text-align: center;
        }

        .image-failed .image-error {
          display: grid;
        }

        .marker {
          position: absolute;
          display: flex;
          align-items: center;
          gap: 6px;
          max-width: 210px;
          border: 0;
          border-radius: 999px;
          background: var(--card-background-color, #fff);
          box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
          color: var(--primary-text-color);
          cursor: grab;
          font: inherit;
          padding: 5px 8px 5px 5px;
          transform: translate(calc(var(--marker-size) / -2 - 5px), -50%);
        }

        .marker.icon-only {
          display: grid;
          place-items: center;
          width: calc(var(--marker-size) + 10px);
          height: calc(var(--marker-size) + 10px);
          max-width: none;
          padding: 5px;
        }

        .marker:active {
          cursor: grabbing;
        }

        .marker span {
          display: grid;
          place-items: center;
          width: var(--marker-size);
          height: var(--marker-size);
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85);
          line-height: 0;
        }

        .marker ha-icon {
          --mdc-icon-size: calc(var(--marker-size) * 0.68);
          display: block;
          width: calc(var(--marker-size) * 0.68);
          height: calc(var(--marker-size) * 0.68);
          line-height: 1;
        }

        .marker strong {
          max-width: 170px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
        }

        .missing-image {
          display: grid;
          min-height: 520px;
          place-items: center;
          border: 1px dashed var(--dmp-border);
          border-radius: 8px;
          color: var(--dmp-muted);
          text-align: center;
        }

        .export {
          border-top: 1px solid var(--dmp-border);
          padding-top: 10px;
        }

        .export summary {
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
        }

        textarea {
          box-sizing: border-box;
          width: 100%;
          min-height: 150px;
          margin-top: 8px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          font: 12px/1.4 monospace;
          padding: 8px;
          resize: vertical;
        }

        @media (max-width: 900px) {
          .panel {
            grid-template-columns: 1fr;
          }

          aside {
            border-right: 0;
            border-bottom: 1px solid var(--dmp-border);
            max-height: 520px;
          }

          .map-toolbar {
            grid-template-columns: 1fr;
            width: auto;
          }

          .display-controls {
            width: 100%;
            min-width: 0;
            border-left: 0;
            border-right: 0;
            border-top: 1px solid var(--dmp-border);
            border-bottom: 1px solid var(--dmp-border);
            margin-left: 0;
            padding-left: 0;
            padding: 6px 0;
          }
        }
      </style>
    `;
  }
}

customElements.define("device-map-panel", DeviceMapPanel);

class DeviceMapPanelEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this.innerHTML = `
      <div style="padding: 12px; color: var(--primary-text-color);">
        Configure this card in YAML with an image, then drag devices from the sidebar onto the drawing.
      </div>
    `;
  }
}

customElements.define("device-map-panel-editor", DeviceMapPanelEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "device-map-panel",
  name: "Device Map Panel",
  description: "Drag-and-drop Home Assistant device status map for floor plans and drawings.",
});
