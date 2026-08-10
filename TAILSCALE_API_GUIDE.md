# 🌊 Hydrological Data API — Tailscale Proxy Guide

This document explains how to access and query the Hydrological Situation Dashboard APIs over the Tailscale network via the central proxy server.

---

## 📌 Network & Server Details

- **Tailscale Host IP**: `100.80.89.27`
- **Proxy Port**: `8000`
- **Base Proxy URL**: `http://100.80.89.27:8000`
- **Dashboard API Route Prefix**: `/proxy_api_daily/`

> All requests sent to `http://100.80.89.27:8000/proxy_api_daily/...` are automatically forwarded to the underlying Flask backend service running on port `5000`.

---

## 🚀 Available Endpoints & Query Parameters

### 1. All Stations — Full History (2014 to Present)
Retrieves combined historical telemetry from static CSVs (2014–Aug 2025) and live SQLite database records (Aug 2025–Present) for **all 77 stations**.

- **URL**: `http://100.80.89.27:8000/proxy_api_daily/api/history-all`
- **Alternative**: `http://100.80.89.27:8000/proxy_api_daily/api/history` *(omitting `name` parameter)*
- **HTTP Method**: `GET`

#### Example Response:
```json
{
  "success": true,
  "source": "csv+database",
  "total_stations": 77,
  "stations": {
    "TARBELA": {
      "inflow": [
        { "x": "15-Jun-2025 12:00 PKT", "y": 178000.0 },
        { "x": "10-Aug-2026 06:00 PKT", "y": 191000.0 }
      ],
      "outflow": [ ... ]
    },
    "MANGLA": { ... },
    "KALABAGH": { ... }
  }
}
```

---

### 2. All Stations — Last 30 Days Filter *(Lightweight & Fast)*
Returns telemetry records for the last 30 days across all stations. Recommended for quick UI dashboard loading to prevent browser memory issues.

- **URL**: `http://100.80.89.27:8000/proxy_api_daily/api/history-all?days=30`
- **Query Parameter**: `days=30` (or any custom integer e.g. `days=7`, `days=60`)
- **HTTP Method**: `GET`

#### cURL Example:
```bash
curl -X GET "http://100.80.89.27:8000/proxy_api_daily/api/history-all?days=30"
```

---

### 3. All Stations — Custom Date Range
Returns telemetry records for all stations between a specified start and end date.

- **URL**: `http://100.80.89.27:8000/proxy_api_daily/api/history-all?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- **Query Parameters**:
  - `start_date`: Start date (`YYYY-MM-DD`) e.g. `2026-07-01`
  - `end_date`: End date (`YYYY-MM-DD`) e.g. `2026-08-10`

#### Example Request:
```http
GET http://100.80.89.27:8000/proxy_api_daily/api/history-all?start_date=2026-07-01&end_date=2026-08-10
```

---

### 4. Single Station Query
Returns historical inflow and outflow time-series for a specific dam, headwork, or gauge station.

- **URL**: `http://100.80.89.27:8000/proxy_api_daily/api/history?name=<STATION_NAME>&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- **Query Parameters**:
  - `name`: Station name (e.g. `TARBELA`, `MANGLA`, `KALABAGH`, `QADIRABAD`, `CHASHMA`, `PANJNAD`)
  - `start_date`: `2014-01-01`
  - `end_date`: `2026-08-10`

#### Example Request:
```http
GET http://100.80.89.27:8000/proxy_api_daily/api/history?name=TARBELA&start_date=2014-01-01&end_date=2026-08-10
```

#### Single Station Response:
```json
{
  "success": true,
  "name": "TARBELA",
  "start_date": "2014-01-01",
  "end_date": "2026-08-10",
  "source": "csv+database",
  "points": 952,
  "inflow": [
    { "x": "15-Jun-2025 12:00 PKT", "y": 178000.0 },
    { "x": "19-Aug-2025 06:00 PST", "y": 309000.0 },
    { "x": "10-Aug-2026 06:00 PKT", "y": 191000.0 }
  ],
  "outflow": [
    { "x": "15-Jun-2025 12:00 PKT", "y": 160000.0 }
  ]
}
```

---

### 5. Current Real-Time Telemetry Snapshot
Returns the latest cached telemetry snapshot for dams and headworks.

- **URL**: `http://100.80.89.27:8000/proxy_api_daily/api/ffd-telemetries`
- **Dams Only**: `http://100.80.89.27:8000/proxy_api_daily/api/ffd-dams`
- **Headworks Only**: `http://100.80.89.27:8000/proxy_api_daily/api/ffd-headworks`

---

## 💻 Code Integration Examples

### JavaScript (Browser / Fetch API)

```javascript
// Fetch last 30 days of data for all stations
async function load30DayHistory() {
  const url = 'http://100.80.89.27:8000/proxy_api_daily/api/history-all?days=30';
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log(`Loaded history for ${data.total_stations} stations:`, data.stations);
  } catch (error) {
    console.error('Failed to fetch Tailscale API data:', error);
  }
}
```

### Python (`requests`)

```python
import requests

# Fetch single station history
url = "http://100.80.89.27:8000/proxy_api_daily/api/history"
params = {
    "name": "TARBELA",
    "start_date": "2014-01-01",
    "end_date": "2026-08-10"
}

response = requests.get(url, params=params)
data = response.json()

print(f"Station: {data['name']} | Total Points: {data['points']}")
print(f"Latest Reading: {data['inflow'][-1]}")
```

---

## 📅 Timestamp Formatting Notes

All timestamp strings in the `"x"` field are standardized with explicit **4-digit years**:
- **CSV Data**: `"18-Aug-2025 23:59 PKT"`
- **Database Data**: `"19-Aug-2025 06:00 PST"`, `"10-Aug-2026 06:00 PKT"`, `"15-May-2027 06:00 PST"`

This guarantees that frontend chart engines (Chart.js, Highcharts, ApexCharts, ECharts) parse time axes accurately across calendar years.
