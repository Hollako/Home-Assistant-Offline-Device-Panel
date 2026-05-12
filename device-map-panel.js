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
      floors: [],
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
    this._floors = [];
    this._activeFloorId = "";
    this._floorMarkers = {};
    this._markers = {};
    this._filters = {
      status: "all",
      domain: "all",
      integration: "all",
      area: "all",
      search: "",
    };
    this._mode = "user";
    this._sidebarCollapsed = false;
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
    this._deviceListScrollTop = 0;
    this._isPanning = false;
    this._selectedMarkers = new Set();
    this._dragMarkerKey = null;
    this._selectionBox = null;
    this._selectionBoxElement = null;
    this._boundKeydown = (event) => this._handleKeydown(event);
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
      floors: [],
      persist_layout: true,
      storage_key: "",
      marker_size: 18,
      show_labels: true,
      show_entity_state: false,
      ...config,
    };
    this._floors = this._normalizedFloors(this._config);
    if (!this._floors.some((floor) => floor.id === this._activeFloorId)) {
      this._activeFloorId = this._floors[0]?.id || "default";
    }
    this._display = this._normalizedDisplay({
      markerSize: this._config.marker_size,
      showLabels: this._config.show_labels,
      ...this._loadDisplay(),
    });
    this._floorMarkers = this._mergedFloorMarkers(this._configFloorMarkers(), this._loadMarkers());
    this._markers = this._floorMarkers[this._activeFloorId] || {};
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

  connectedCallback() {
    window.addEventListener("keydown", this._boundKeydown);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._boundKeydown);
  }

  _canEdit() {
    return this._hass?.user?.is_admin === true;
  }

  _isControlActive() {
    const active = this.shadowRoot?.activeElement;
    return this._isPanning || ["INPUT", "SELECT", "TEXTAREA"].includes(active?.tagName);
  }

  _handleKeydown(event) {
    if (!(this._canEdit() && this._mode === "edit")) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const active = this.shadowRoot?.activeElement || document.activeElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(active?.tagName)) return;
    if (!this._selectedMarkers.size) return;

    event.preventDefault();
    for (const key of this._selectedMarkers) {
      delete this._markers[key];
    }
    this._selectedMarkers.clear();
    this._saveMarkers();
    this._render();
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
          primaryState: stateObj.state,
          primaryDomain: domain,
          primaryDeviceClass: stateObj.attributes?.device_class || "",
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

      if (row.entityId === entityId || isOffline || (!row.offline && row.primaryState == null)) {
        row.primaryState = stateObj.state;
        row.primaryDomain = domain;
        row.primaryDeviceClass = stateObj.attributes?.device_class || "";
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

  _stateClass(row) {
    if (!this._config.show_entity_state) return "";
    const state = String(row.primaryState || "").toLowerCase();
    const activeStates = ["on", "open", "opening", "unlocked", "detected", "motion", "home", "playing", "heat", "cool"];
    const inactiveStates = ["off", "closed", "closing", "locked", "clear", "none", "not_home", "idle", "standby"];

    if (activeStates.includes(state)) return "state-active";
    if (inactiveStates.includes(state)) return "state-inactive";
    if (row.primaryDomain === "binary_sensor") return state === "on" ? "state-active" : "state-inactive";
    if (row.primaryDomain === "light" || row.primaryDomain === "switch") return state === "on" ? "state-active" : "state-inactive";
    return "state-neutral";
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

  _normalizedFloors(config) {
    const configuredFloors = Array.isArray(config.floors) ? config.floors : [];
    const source = configuredFloors.length
      ? configuredFloors
      : [
          {
            id: "default",
            name: config.title || "Floor",
            image: config.image || "",
            markers: config.markers || [],
          },
        ];
    const seen = new Set();

    return source.map((floor, index) => {
      const fallback = `floor-${index + 1}`;
      const rawId = floor.id || floor.name || fallback;
      let id = String(rawId)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || fallback;
      while (seen.has(id)) id = `${id}-${index + 1}`;
      seen.add(id);
      return {
        id,
        name: floor.name || floor.title || rawId || `Floor ${index + 1}`,
        image: floor.image || "",
        markers: Array.isArray(floor.markers) ? floor.markers : [],
      };
    });
  }

  _hasMultipleFloors() {
    return Array.isArray(this._config.floors) && this._config.floors.length > 0;
  }

  _activeFloor() {
    return this._floors.find((floor) => floor.id === this._activeFloorId) || this._floors[0] || { id: "default", name: this._config.title, image: this._config.image };
  }

  _options(rows, key) {
    const values = rows.flatMap((row) => {
      const value = row[key];
      return Array.isArray(value) ? value : [value];
    });
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  _configMarkers() {
    return this._markersFromList(this._config.markers || []);
  }

  _configFloorMarkers() {
    if (!this._hasMultipleFloors()) {
      return { [this._activeFloorId || "default"]: this._configMarkers() };
    }

    return this._floors.reduce((result, floor) => {
      result[floor.id] = this._markersFromList(floor.markers || []);
      return result;
    }, {});
  }

  _markersFromList(markersList) {
    return (markersList || []).reduce((markers, marker) => {
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
    return `device-map-panel:${this._hasMultipleFloors() ? "floors" : "markers"}:${path}:${cardKey}`;
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
      this._floorMarkers[this._activeFloorId] = this._markers;
      localStorage.setItem(this._storageKey(), JSON.stringify(this._hasMultipleFloors() ? this._floorMarkers : this._markers));
    } catch (error) {
      console.warn("device-map-panel: marker layout could not be saved", error);
    }
  }

  _mergedFloorMarkers(configMarkers, savedMarkers) {
    const result = {};
    for (const floor of this._floors) {
      result[floor.id] = this._normalizedMarkers(configMarkers[floor.id] || {});
    }

    if (this._hasMultipleFloors()) {
      const savedByFloor = this._looksLikeFloorMarkers(savedMarkers)
        ? savedMarkers
        : { [this._activeFloorId || this._floors[0]?.id || "default"]: savedMarkers };
      for (const floor of this._floors) {
        result[floor.id] = this._normalizedMarkers({
          ...result[floor.id],
          ...(savedByFloor[floor.id] || {}),
        });
      }
      return result;
    }

    const floorId = this._floors[0]?.id || "default";
    result[floorId] = this._normalizedMarkers({
      ...(result[floorId] || {}),
      ...(this._looksLikeFloorMarkers(savedMarkers) ? savedMarkers[floorId] || {} : savedMarkers || {}),
    });
    return result;
  }

  _looksLikeFloorMarkers(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value).some((entry) => entry && typeof entry === "object" && !("x" in entry) && !("y" in entry));
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
    this._captureDeviceListScroll();

    const rows = this._deviceRows();
    const filteredRows = this._filteredRows(rows);
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    const activeFloor = this._activeFloor();
    const floorTitle = this._hasMultipleFloors() ? `${this._config.title} - ${activeFloor.name}` : this._config.title;
    const placedRows = Object.keys(this._markers)
      .map((key) => rowByKey.get(key))
      .filter(Boolean);
    const offlineCount = placedRows.filter((row) => row.offline).length;
    const canEdit = this._canEdit();
    const isEditing = canEdit && this._mode === "edit";
    const modeLabel = isEditing ? "Edit Mode" : "User Mode";

    this.shadowRoot.innerHTML = `
      <ha-card>
        <div class="panel ${isEditing ? "editing" : "viewing"} ${isEditing && this._sidebarCollapsed ? "sidebar-collapsed" : ""}">
          ${
            isEditing && !this._sidebarCollapsed
              ? `
          <aside>
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
            <section class="bulk-actions">
              <button type="button" data-auto-place="filtered">Scatter visible unplaced</button>
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
              <div class="toolbar-title">${this._escape(floorTitle)}</div>
              ${
                this._hasMultipleFloors()
                  ? `
              <label class="floor-switch" title="Floor">
                <span>Floor</span>
                <select data-floor>
                  ${this._floors
                    .map((floor) => `<option value="${this._escape(floor.id)}" ${floor.id === this._activeFloorId ? "selected" : ""}>${this._escape(floor.name)}</option>`)
                    .join("")}
                </select>
              </label>
              `
                  : ""
              }
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
              ${
                isEditing
                  ? `<button type="button" class="sidebar-toggle" data-sidebar-toggle title="${this._sidebarCollapsed ? "Show device sidebar" : "Hide device sidebar"}">
                ${this._sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar"}
              </button>`
                  : ""
              }
              <div class="align-controls" aria-label="Marker alignment">
                <span>${this._selectedMarkers.size} selected</span>
                <button type="button" class="tool-icon" data-align="left" title="Align selected left" aria-label="Align selected left" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-left"></span>
                </button>
                <button type="button" class="tool-icon" data-align="right" title="Align selected right" aria-label="Align selected right" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-right"></span>
                </button>
                <button type="button" class="tool-icon" data-align="top" title="Align selected top" aria-label="Align selected top" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-top"></span>
                </button>
                <button type="button" class="tool-icon" data-align="bottom" title="Align selected bottom" aria-label="Align selected bottom" ${this._selectedMarkers.size < 2 ? "disabled" : ""}>
                  <span class="align-icon align-bottom"></span>
                </button>
                <button type="button" class="tool-icon" data-distribute="horizontal" title="Distribute selected evenly left to right" aria-label="Distribute selected horizontally" ${this._selectedMarkers.size < 3 ? "disabled" : ""}>
                  <span class="align-icon distribute-horizontal"></span>
                </button>
                <button type="button" class="tool-icon" data-distribute="vertical" title="Distribute selected evenly top to bottom" aria-label="Distribute selected vertically" ${this._selectedMarkers.size < 3 ? "disabled" : ""}>
                  <span class="align-icon distribute-vertical"></span>
                </button>
                <button type="button" data-clear-selection title="Clear selection" ${this._selectedMarkers.size ? "" : "disabled"}>Clear</button>
              </div>
              <div class="mode-switch" aria-label="Map mode">
                <button type="button" data-mode="user" class="${!isEditing ? "active" : ""}">User Mode</button>
                <button type="button" data-mode="edit" class="${isEditing ? "active" : ""}">Edit Mode</button>
              </div>
              `
                  : ""
              }
            </div>
            ${
              activeFloor.image
                ? `
            <div class="map ${isEditing ? "editable" : ""} ${this._zoom < 1 ? "zoomed-out" : ""}" data-map>
              <div class="map-content" style="width: ${this._escape(this._zoom * 100)}%;">
                <img src="${this._escape(activeFloor.image)}" alt="" />
                <div class="image-error">Image could not be loaded: ${this._escape(activeFloor.image)}</div>
                ${placedRows.map((row) => this._markerTemplate(row, isEditing)).join("")}
                ${isEditing && this._selectionBox ? this._selectionBoxTemplate() : ""}
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
    requestAnimationFrame(() => {
      this._restoreMapScroll();
      this._restoreDeviceListScroll();
    });
  }

  _attachEvents() {
    const isEditing = this._canEdit() && this._mode === "edit";

    this.shadowRoot.querySelectorAll("[data-mode]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._mode = event.currentTarget.dataset.mode === "edit" ? "edit" : "user";
        if (this._mode !== "edit") {
          this._selectedMarkers.clear();
          this._sidebarCollapsed = false;
        }
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-floor]").forEach((element) => {
      element.addEventListener("change", (event) => {
        const floorId = event.currentTarget.value;
        if (!this._floors.some((floor) => floor.id === floorId)) return;
        this._floorMarkers[this._activeFloorId] = this._markers;
        this._activeFloorId = floorId;
        this._markers = this._floorMarkers[floorId] || {};
        this._selectedMarkers.clear();
        this._selectionBox = null;
        this._mapScroll = { left: 0, top: 0 };
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-sidebar-toggle]").forEach((element) => {
      element.addEventListener("click", () => {
        this._sidebarCollapsed = !this._sidebarCollapsed;
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

    const deviceList = this.shadowRoot.querySelector(".devices");
    if (deviceList) {
      deviceList.addEventListener("scroll", () => this._captureDeviceListScroll());
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
        const key = event.currentTarget.dataset.remove;
        delete this._markers[key];
        this._selectedMarkers.delete(key);
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

    this.shadowRoot.querySelectorAll("[data-auto-place]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._autoPlaceMarkers(event.currentTarget.dataset.autoPlace);
      });
    });

    this.shadowRoot.querySelectorAll("[data-align]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._alignSelectedMarkers(event.currentTarget.dataset.align);
      });
    });

    this.shadowRoot.querySelectorAll("[data-distribute]").forEach((element) => {
      element.addEventListener("click", (event) => {
        this._distributeSelectedMarkers(event.currentTarget.dataset.distribute);
      });
    });

    this.shadowRoot.querySelectorAll("[data-clear-selection]").forEach((element) => {
      element.addEventListener("click", () => {
        this._selectedMarkers.clear();
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-marker]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        const key = event.currentTarget.dataset.marker;
        this._dragMarkerKey = key;
        event.dataTransfer.setData("text/plain", key);
        event.dataTransfer.effectAllowed = "move";
        if ((event.ctrlKey || event.metaKey) && key) this._selectedMarkers.add(key);
      });
      element.addEventListener("dragend", () => {
        this._dragMarkerKey = null;
      });
      element.addEventListener("click", (event) => {
        const key = event.currentTarget.dataset.marker;
        if (key) {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) {
            if (this._selectedMarkers.has(key)) this._selectedMarkers.delete(key);
            else this._selectedMarkers.add(key);
          } else {
            this._selectedMarkers.clear();
            this._selectedMarkers.add(key);
          }
          this._render();
          return;
        }

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
        const existingMarker = this._markers[key];
        const moveSelectedGroup = (event.ctrlKey || event.metaKey) && existingMarker && this._selectedMarkers.has(key) && this._selectedMarkers.size > 1;

        if (moveSelectedGroup) {
          const deltaX = point.x - existingMarker.x;
          const deltaY = point.y - existingMarker.y;
          for (const selectedKey of this._selectedMarkers) {
            const marker = this._markers[selectedKey];
            if (!marker) continue;
            marker.x = Math.max(0, Math.min(100, marker.x + deltaX));
            marker.y = Math.max(0, Math.min(100, marker.y + deltaY));
          }
        } else {
          this._markers[key] = {
            key,
            entityId: row.entityId,
            name: row.name,
            icon: existingMarker?.icon || "",
            x: point.x,
            y: point.y,
          };
          this._selectedMarkers.clear();
          this._selectedMarkers.add(key);
        }
        this._dragMarkerKey = null;
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

  _selectionBoxTemplate() {
    const box = this._normalizedSelectionBox();
    return `
      <div
        class="selection-box"
        style="left: ${this._escape(box.left)}%; top: ${this._escape(box.top)}%; width: ${this._escape(box.width)}%; height: ${this._escape(box.height)}%;"
      ></div>
    `;
  }

  _normalizedSelectionBox() {
    const box = this._selectionBox || { startX: 0, startY: 0, endX: 0, endY: 0 };
    const left = Math.min(box.startX, box.endX);
    const right = Math.max(box.startX, box.endX);
    const top = Math.min(box.startY, box.endY);
    const bottom = Math.max(box.startY, box.endY);
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  _updateSelectionFromBox(additive = false) {
    if (!this._selectionBox) return;
    const box = this._normalizedSelectionBox();
    if (!additive) this._selectedMarkers.clear();

    for (const [key, marker] of Object.entries(this._markers)) {
      if (marker.x >= box.left && marker.x <= box.right && marker.y >= box.top && marker.y <= box.bottom) {
        this._selectedMarkers.add(key);
      }
    }
  }

  _updateSelectionBoxElement(map) {
    if (!this._selectionBox) return;
    const content = map.querySelector(".map-content");
    if (!content) return;
    if (!this._selectionBoxElement || !content.contains(this._selectionBoxElement)) {
      this._selectionBoxElement = document.createElement("div");
      this._selectionBoxElement.className = "selection-box";
      content.appendChild(this._selectionBoxElement);
    }

    const box = this._normalizedSelectionBox();
    this._selectionBoxElement.style.left = `${box.left}%`;
    this._selectionBoxElement.style.top = `${box.top}%`;
    this._selectionBoxElement.style.width = `${box.width}%`;
    this._selectionBoxElement.style.height = `${box.height}%`;
  }

  _removeSelectionBoxElement() {
    this._selectionBoxElement?.remove();
    this._selectionBoxElement = null;
  }

  _syncSelectedMarkerClasses(map) {
    map.querySelectorAll("[data-marker]").forEach((marker) => {
      marker.classList.toggle("selected", this._selectedMarkers.has(marker.dataset.marker));
    });
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

  _captureDeviceListScroll() {
    const deviceList = this.shadowRoot?.querySelector(".devices");
    if (!deviceList) return;
    this._deviceListScrollTop = deviceList.scrollTop;
  }

  _restoreDeviceListScroll() {
    const deviceList = this.shadowRoot?.querySelector(".devices");
    if (!deviceList) return;
    deviceList.scrollTop = this._deviceListScrollTop;
  }

  _attachPanEvents(map) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let panning = false;
    let selecting = false;
    let pointerId = null;

    map.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-marker]")) return;
      if (event.button !== undefined && event.button !== 0) return;

      event.preventDefault();
      pointerId = event.pointerId;
      if (event.shiftKey && this._canEdit() && this._mode === "edit") {
        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        selecting = true;
        this._selectionBox = {
          startX: point.x,
          startY: point.y,
          endX: point.x,
          endY: point.y,
        };
        map.classList.add("selecting");
        map.setPointerCapture?.(event.pointerId);
        this._updateSelectionFromBox(event.ctrlKey || event.metaKey);
        this._updateSelectionBoxElement(map);
        this._syncSelectedMarkerClasses(map);
        return;
      }

      const canScrollX = map.scrollWidth > map.clientWidth;
      const canScrollY = map.scrollHeight > map.clientHeight;
      if (!canScrollX && !canScrollY) return;

      panning = true;
      this._isPanning = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = map.scrollLeft;
      startTop = map.scrollTop;
      map.classList.add("panning");
      map.setPointerCapture?.(event.pointerId);
    });

    const movePan = (event) => {
      if (selecting) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        event.preventDefault();
        const point = this._pointFromEvent(map.querySelector(".map-content") || map, event);
        this._selectionBox = {
          ...this._selectionBox,
          endX: point.x,
          endY: point.y,
        };
        this._updateSelectionFromBox(event.ctrlKey || event.metaKey);
        this._updateSelectionBoxElement(map);
        this._syncSelectedMarkerClasses(map);
        return;
      }

      if (!panning) return;
      if (pointerId !== null && event.pointerId !== pointerId) return;
      event.preventDefault();
      map.scrollLeft = startLeft - (event.clientX - startX);
      map.scrollTop = startTop - (event.clientY - startY);
      this._captureMapScroll();
    };

    map.addEventListener("pointermove", movePan);

    const stopPan = (event) => {
      if (selecting) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        selecting = false;
        pointerId = null;
        this._selectionBox = null;
        this._removeSelectionBoxElement();
        map.classList.remove("selecting");
        map.releasePointerCapture?.(event.pointerId);
        this._render();
        return;
      }

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

  _alignSelectedMarkers(direction) {
    const selected = [...this._selectedMarkers]
      .map((key) => this._markers[key])
      .filter(Boolean);
    if (selected.length < 2) return;

    const values = {
      left: Math.min(...selected.map((marker) => marker.x)),
      right: Math.max(...selected.map((marker) => marker.x)),
      top: Math.min(...selected.map((marker) => marker.y)),
      bottom: Math.max(...selected.map((marker) => marker.y)),
    };

    if (!Object.prototype.hasOwnProperty.call(values, direction)) return;

    for (const marker of selected) {
      if (direction === "left" || direction === "right") marker.x = values[direction];
      if (direction === "top" || direction === "bottom") marker.y = values[direction];
    }

    this._saveMarkers();
    this._render();
  }

  _distributeSelectedMarkers(axis) {
    const selected = [...this._selectedMarkers]
      .map((key) => this._markers[key])
      .filter(Boolean);
    if (selected.length < 3) return;

    const key = axis === "vertical" ? "y" : "x";
    const sorted = selected.sort((a, b) => a[key] - b[key]);
    const first = sorted[0][key];
    const last = sorted[sorted.length - 1][key];
    const step = (last - first) / (sorted.length - 1);

    sorted.forEach((marker, index) => {
      marker[key] = first + step * index;
    });

    this._saveMarkers();
    this._render();
  }

  _autoPlaceMarkers(scope) {
    const rows = this._deviceRows();
    const sourceRows = scope === "all" ? rows : this._filteredRows(rows);
    const unplaced = sourceRows.filter((row) => !this._markers[row.key]);
    if (!unplaced.length) return;

    const columns = Math.ceil(Math.sqrt(unplaced.length));
    const rowsCount = Math.ceil(unplaced.length / columns);
    const xMin = 8;
    const xMax = 92;
    const yMin = 8;
    const yMax = 92;
    const xStep = columns > 1 ? (xMax - xMin) / (columns - 1) : 0;
    const yStep = rowsCount > 1 ? (yMax - yMin) / (rowsCount - 1) : 0;

    this._selectedMarkers.clear();

    unplaced.forEach((row, index) => {
      const column = index % columns;
      const rowIndex = Math.floor(index / columns);
      const jitterX = columns > 1 ? (Math.random() - 0.5) * Math.min(4, xStep * 0.35) : 0;
      const jitterY = rowsCount > 1 ? (Math.random() - 0.5) * Math.min(4, yStep * 0.35) : 0;

      this._markers[row.key] = {
        key: row.key,
        entityId: row.entityId,
        name: row.name,
        icon: this._markers[row.key]?.icon || "",
        x: Math.max(0, Math.min(100, xMin + xStep * column + jitterX)),
        y: Math.max(0, Math.min(100, yMin + yStep * rowIndex + jitterY)),
      };
      this._selectedMarkers.add(row.key);
    });

    this._saveMarkers();
    this._render();
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
      <div class="device-row ${placed ? "is-placed" : ""} ${row.offline ? "offline" : "online"}" draggable="true" data-device="${this._escape(row.key)}">
        <span class="dot"><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        <span class="device-text">
          <strong>${this._escape(row.name)}</strong>
          <small>${this._escape(row.areaName)} - ${this._escape(row.domain || row.integration)}</small>
        </span>
        ${
          placed
            ? `<button type="button" class="remove" data-remove="${this._escape(row.key)}" title="Remove from map">Remove</button>`
            : `<span class="placed">Drag</span>`
        }
        ${placed ? this._iconSelect(row) : ""}
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
    const stateClass = this._stateClass(row);
    const title = this._config.show_entity_state ? `${row.name} - ${row.primaryState}` : row.name;
    return `
      <button
        class="marker ${this._display.showLabels ? "with-label" : "icon-only"} ${this._config.show_entity_state ? "state-mode" : ""} ${stateClass} ${isEditing && this._selectedMarkers.has(row.key) ? "selected" : ""} ${row.offline ? "offline" : "online"}"
        style="left: ${this._escape(marker.x)}%; top: ${this._escape(marker.y)}%; --marker-size: ${this._escape(size)}px;"
        draggable="${isEditing ? "true" : "false"}"
        data-marker="${this._escape(row.key)}"
        data-entity="${this._escape(row.entityId)}"
        title="${this._escape(title)}"
      >
        <span><ha-icon icon="${this._escape(icon)}"></ha-icon></span>
        ${this._display.showLabels ? `<strong>${this._escape(row.name)}</strong>` : ""}
      </button>
    `;
  }

  _yamlExport(rows) {
    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    if (this._hasMultipleFloors()) {
      return [
        "floors:",
        ...this._floors.flatMap((floor) => {
          const markers = this._yamlMarkersForFloor(floor.id, rowByKey);
          return [
            `  - id: ${floor.id}`,
            `    name: ${floor.name}`,
            `    image: ${floor.image}`,
            ...(markers.length
              ? [
                  "    markers:",
                  ...markers.flatMap((marker) => [
                    `      - key: ${marker.key}`,
                    `        entity: ${marker.entity}`,
                    `        name: ${marker.name}`,
                    ...(marker.icon ? [`        icon: ${marker.icon}`] : []),
                    `        x: ${marker.x}`,
                    `        y: ${marker.y}`,
                  ]),
                ]
              : ["    markers: []"]),
          ];
        }),
      ].join("\n");
    }

    const markers = this._yamlMarkersForFloor(this._activeFloorId, rowByKey);

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

  _yamlMarkersForFloor(floorId, rowByKey) {
    const floorMarkers = floorId === this._activeFloorId ? this._markers : this._floorMarkers[floorId] || {};
    return Object.entries(floorMarkers)
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

        .panel.sidebar-collapsed {
          grid-template-columns: 1fr;
        }

        aside {
          position: sticky;
          top: 12px;
          display: grid;
          grid-template-rows: auto auto minmax(320px, 1fr) auto;
          gap: 8px;
          min-width: 0;
          height: calc(100vh - 24px);
          max-height: calc(100vh - 24px);
          border-right: 1px solid var(--dmp-border);
          box-sizing: border-box;
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

        .filters, .bulk-actions {
          display: grid;
          gap: 8px;
        }

        .bulk-actions {
          grid-template-columns: 1fr;
          border-top: 1px solid var(--dmp-border);
          padding: 8px 0 0;
        }

        .bulk-actions button {
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--secondary-background-color, #f7f8fa);
          color: var(--primary-text-color);
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          min-height: 36px;
        }

        .bulk-actions button:hover {
          border-color: var(--primary-color, #03a9f4);
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
          grid-auto-rows: max-content;
          gap: 7px;
          min-height: 0;
          overflow: auto;
          padding-right: 2px;
        }

        .device-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: start;
          gap: 9px;
          min-height: 48px;
          border: 1px solid var(--dmp-border);
          border-radius: 8px;
          background: var(--card-background-color, #fff);
          cursor: grab;
          padding: 8px;
        }

        .device-row.is-placed {
          grid-template-rows: auto auto;
          row-gap: 8px;
          min-height: 84px;
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
          margin-top: 2px;
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
          grid-column: 2 / 4;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 6px;
          margin-top: 0;
          align-self: end;
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
          display: flex;
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
          flex: 1 1 160px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--primary-text-color);
          font-size: 14px;
          font-weight: 800;
          padding: 0 10px;
        }

        .floor-switch {
          display: flex;
          align-items: center;
          flex: 1 1 280px;
          gap: 6px;
          min-width: 260px;
          max-width: 460px;
        }

        .floor-switch select {
          min-height: 30px;
          max-width: none;
          padding: 0 8px;
        }

        .floor-switch span {
          white-space: nowrap;
        }

        .mode-switch {
          display: flex;
          gap: 4px;
        }

        .align-controls {
          display: flex;
          align-items: center;
          gap: 4px;
          border-left: 1px solid var(--dmp-border);
          padding-left: 10px;
        }

        .align-controls span {
          color: var(--dmp-muted);
          font-size: 12px;
          font-weight: 700;
          padding-right: 4px;
          white-space: nowrap;
        }

        .mode-switch button, .align-controls button, .sidebar-toggle {
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

        .sidebar-toggle {
          border-left: 1px solid var(--dmp-border);
          color: var(--primary-text-color);
          white-space: nowrap;
        }

        .sidebar-toggle:hover {
          background: var(--secondary-background-color, #f7f8fa);
        }

        .align-controls .tool-icon {
          display: grid;
          place-items: center;
          min-width: 34px;
          padding: 0;
        }

        .align-icon {
          position: relative;
          display: block;
          width: 22px;
          height: 22px;
          --guide-color: var(--primary-text-color);
          --block-color: #c052a8;
        }

        .align-icon::before,
        .align-icon::after {
          content: "";
          position: absolute;
          box-sizing: border-box;
        }

        .align-left::before,
        .align-right::before,
        .distribute-horizontal::before {
          top: 2px;
          bottom: 2px;
          width: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .align-left::before {
          left: 3px;
        }

        .align-right::before {
          right: 3px;
        }

        .align-left::after {
          left: 8px;
          top: 5px;
          width: 11px;
          height: 13px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 11px 5px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 0 8px / 8px 5px no-repeat;
        }

        .align-right::after {
          right: 8px;
          top: 5px;
          width: 11px;
          height: 13px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 11px 5px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 3px 8px / 8px 5px no-repeat;
        }

        .distribute-horizontal::before,
        .distribute-horizontal::after {
          top: 2px;
          bottom: 2px;
          width: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .distribute-horizontal::before {
          left: 2px;
        }

        .distribute-horizontal::after {
          right: 2px;
        }

        .distribute-horizontal {
          background:
            linear-gradient(var(--block-color), var(--block-color)) 7px 5px / 4px 12px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 14px 5px / 4px 12px no-repeat;
        }

        .align-top::before,
        .align-bottom::before {
          left: 2px;
          right: 2px;
          height: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .align-top::before {
          top: 3px;
        }

        .align-bottom::before {
          bottom: 3px;
        }

        .align-top::after {
          left: 5px;
          top: 8px;
          width: 13px;
          height: 11px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 5px 11px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 8px 0 / 5px 8px no-repeat;
        }

        .align-bottom::after {
          left: 5px;
          bottom: 8px;
          width: 13px;
          height: 11px;
          background:
            linear-gradient(var(--block-color), var(--block-color)) 0 0 / 5px 8px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 8px 0 / 5px 11px no-repeat;
        }

        .distribute-vertical::before,
        .distribute-vertical::after {
          left: 2px;
          right: 2px;
          height: 3px;
          border-radius: 2px;
          background: var(--guide-color);
        }

        .distribute-vertical::before {
          top: 2px;
        }

        .distribute-vertical::after {
          bottom: 2px;
        }

        .distribute-vertical {
          background:
            linear-gradient(var(--block-color), var(--block-color)) 6px 7px / 10px 4px no-repeat,
            linear-gradient(var(--block-color), var(--block-color)) 6px 14px / 10px 4px no-repeat;
        }

        .align-controls button:disabled {
          cursor: not-allowed;
          opacity: 0.45;
        }

        .align-controls button:not(:disabled):hover {
          background: var(--secondary-background-color, #f7f8fa);
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

        .map.selecting {
          cursor: crosshair;
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
          z-index: 3;
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

        .selection-box {
          position: absolute;
          z-index: 2;
          border: 1px solid var(--primary-color, #03a9f4);
          background: rgba(3, 169, 244, 0.16);
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
          pointer-events: none;
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

        .marker.selected {
          outline: 3px solid var(--primary-color, #03a9f4);
          outline-offset: 4px;
        }

        .marker span {
          display: grid;
          place-items: center;
          width: var(--marker-size);
          height: var(--marker-size);
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 0 13px rgba(29, 143, 95, 0.78);
          line-height: 0;
        }

        .marker.online span {
          background: var(--dmp-good);
        }

        .marker.offline span {
          background: var(--dmp-bad);
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85), 0 0 15px rgba(212, 54, 54, 0.9);
        }

        .marker.state-mode.online span {
          box-shadow: 0 0 0 3px rgba(29, 143, 95, 0.96), 0 0 16px rgba(29, 143, 95, 0.8);
        }

        .marker.state-mode.state-active span {
          background: #f5c542;
          color: #111;
        }

        .marker.state-mode.state-inactive span {
          background: #111827;
          color: #fff;
        }

        .marker.state-mode.state-neutral span {
          background: #64748b;
          color: #fff;
        }

        .marker.state-mode.offline span {
          background: var(--dmp-bad);
          color: #fff;
          box-shadow: 0 0 0 3px rgba(212, 54, 54, 0.98), 0 0 18px rgba(212, 54, 54, 0.95);
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
            position: relative;
            top: auto;
            height: auto;
            border-right: 0;
            border-bottom: 1px solid var(--dmp-border);
            max-height: 520px;
          }

          .map-toolbar {
            grid-template-columns: 1fr;
            width: auto;
          }

          .align-controls {
            border-left: 0;
            border-top: 1px solid var(--dmp-border);
            flex-wrap: wrap;
            padding-left: 0;
            padding-top: 6px;
          }

          .floor-switch {
            width: 100%;
          }

          .floor-switch select {
            max-width: none;
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
        Configure this card in YAML with an image or floors, then drag devices from the sidebar onto the drawing.
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
