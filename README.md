# Home Assistant Offline Device Panel

A Lovelace custom card for a clear Home Assistant dashboard view of offline devices.

The card:

- Shows one card per Home Assistant device, grouped by area.
- Uses a red frame for devices with unavailable or unknown entities.
- Uses a green frame for online devices when the online filter is enabled.
- Filters by status, multiple domains, multiple integrations, multiple areas, and search text.
- Switches between detailed cards and simple cards from the dashboard.
- Opens the normal Home Assistant more-info dialog when a device card is clicked.

## Install with HACS

1. In HACS, open the three-dot menu and select **Custom repositories**.
2. Add `https://github.com/Hollako/Home-Assistant-Device-Panel`.
3. Select **Dashboard** as the category.
4. Download **Offline Device Panel**.
5. In Home Assistant, go to **Settings > Dashboards > Resources**.
6. Add this resource:

```yaml
url: /hacsfiles/Home-Assistant-Device-Panel/offline-device-panel.js
type: module
```

7. Add a manual Lovelace card:

```yaml
type: custom:offline-device-panel
title: Offline Devices
show_online: true
display_mode: detailed
offline_states:
  - unavailable
  - unknown
```

## Manual Install

1. Copy `offline-device-panel.js` to your Home Assistant `config/www/` folder.
2. In Home Assistant, go to **Settings > Dashboards > Resources**.
3. Add this resource:

```yaml
url: /local/offline-device-panel.js
type: module
```

4. Add a manual Lovelace card:

```yaml
type: custom:offline-device-panel
title: Offline Devices
show_online: true
display_mode: detailed
offline_states:
  - unavailable
  - unknown
```

## Example Dashboard View

```yaml
title: Device Health
path: device-health
icon: mdi:alert-circle-outline
cards:
  - type: custom:offline-device-panel
    title: Device Health
    show_online: true
    display_mode: detailed
    offline_states:
      - unavailable
      - unknown
```

## Optional Pre-Filters

Use these when you want a dashboard view that starts from a smaller scope.

```yaml
type: custom:offline-device-panel
title: Lighting Health
domains:
  - light
  - switch
integrations:
  - zha
  - mqtt
areas:
  - Living Room
  - Kitchen
offline_states:
  - unavailable
  - unknown
```

## Simple Cards

Use `display_mode: simple` when you want compact cards with less detail.

```yaml
type: custom:offline-device-panel
title: Simple Device Health
display_mode: simple
show_online: true
offline_states:
  - unavailable
  - unknown
```

## Notes

- `domains` use entity domains such as `light`, `cover`, `sensor`, `switch`, `climate`, and `binary_sensor`.
- `integrations` use Home Assistant platform names from the entity registry, such as `zha`, `mqtt`, `shelly`, `hue`, or `esphome`.
- `areas` can be area names or area IDs.
- The dashboard filters for domains, integrations, and areas support multiple checked values.
- If an entity is not attached to a device in the registry, the card still shows it as its own fallback item.
