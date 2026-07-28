// Time functions for temporal WMS layers
function getNextNDays(offset = 0, type = "") {
  const currentDate = new Date();
  const futureDate = new Date(
    currentDate.getTime() + offset * 24 * 60 * 60 * 1000
  );
  const year = futureDate.getFullYear();
  const month = String(futureDate.getMonth() + 1).padStart(2, "0");
  const day = String(futureDate.getDate()).padStart(2, "0");

  if (type === "short") {
    const shortMonthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const shortMonth = shortMonthNames[futureDate.getMonth()];
    return `${day}-${shortMonth}`;
  }
  return `${year}-${month}-${day}`;
}

function getCurrentUtcDateCompact(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function extractLatestMeteoblueTimeValue(payload) {
  const candidates = [];

  (function walk(node) {
    if (node == null) return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node === "object") {
      Object.values(node).forEach(walk);
      return;
    }

    const digits = String(node).match(/\d{8,10}/g);
    if (digits) candidates.push(...digits);
  })(payload);

  return candidates.length ? candidates[candidates.length - 1] : null;
}

function getLatestMeteoblueTimeSync(url, fallbackValue) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);

  try {
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) {
      const payload = JSON.parse(xhr.responseText);
      return extractLatestMeteoblueTimeValue(payload) || fallbackValue;
    }
  } catch (error) {
    console.warn("Meteoblue latest-time lookup failed:", url, error);
  }

  return fallbackValue;
}
function getNextNDaysWithTime(
  offset = 0,
  hours2 = null,
  minutes2 = null,
  seconds2 = null
) {
  const currentDate = new Date();
  const futureDate = new Date(
    currentDate.getTime() + offset * 24 * 60 * 60 * 1000
  );
  const year = futureDate.getUTCFullYear();
  const month = String(futureDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(futureDate.getUTCDate()).padStart(2, "0");

  // Use provided hours2 and minutes2 if they are not null, otherwise use the current time
  const hours =
    hours2 !== null
      ? hours2
      : String(futureDate.getUTCHours()).padStart(2, "0");
  const minutes =
    minutes2 !== null
      ? minutes2
      : String(futureDate.getUTCMinutes()).padStart(2, "0");
  const seconds =
    seconds2 !== null
      ? seconds2
      : String(futureDate.getUTCSeconds()).padStart(2, "0");

  const utcFormattedDateTime = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;

  return utcFormattedDateTime;
}
function getNextNHoursWithTime(
  offset = 0,
  minutes = null,
  seconds = null,
  timeZone = "utc",
  type = "24-hour"
) {
  const currentDate = new Date();
  let futureDate;

  if (typeof offset === "string") {
    // If the offset is a string, set the hour to the specified value
    futureDate = new Date(currentDate);
    futureDate.setUTCHours(Number(offset));
  } else {
    // Otherwise, calculate the future date by adding hours to the current time
    futureDate = new Date(currentDate.getTime() + offset * 60 * 60 * 1000);
  }

  // Adjust futureDate based on time zone if specified
  if (timeZone === "gmt") {
    futureDate.setUTCHours(futureDate.getUTCHours() + 5); // Adjust for GMT+5
  }

  const year = futureDate.getUTCFullYear();
  const month = String(futureDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(futureDate.getUTCDate()).padStart(2, "0");
  const hours = futureDate.getUTCHours();
  const minutesValue = minutes === null ? futureDate.getUTCMinutes() : minutes;
  const secondsValue = seconds === null ? futureDate.getUTCSeconds() : seconds;

  let formattedHours = String(hours).padStart(2, "0");
  const formattedMinutes = String(minutesValue).padStart(2, "0");
  const formattedSeconds = String(secondsValue).padStart(2, "0");

  let formattedDateTime;

  if (type === "short") {
    // Convert to 12-hour format
    const ampm = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12; // Convert hour to 12-hour format
    formattedHours = String(hours12).padStart(2, "0");
    formattedDateTime = `${formattedHours}:${formattedMinutes} ${ampm}`;
  } else {
    // Default to 24-hour format
    if (timeZone === "gmt") {
      formattedDateTime = `${year}-${month}-${day}T${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
    } else {
      formattedDateTime = `${year}-${month}-${day}T${formattedHours}:${formattedMinutes}:${formattedSeconds}Z`;
    }
  }

  return formattedDateTime;
}
function getPastHours(offset = 0, type = "") {
  const currentDate = new Date();
  let roundedMinutes;
  if (offset === 0) {
    roundedMinutes = Math.floor(currentDate.getUTCMinutes() / 15) * 15 - 15; // Round down to nearest 15 minutes and subtract 15 minutes for offset 0
  } else {
    roundedMinutes = Math.floor(currentDate.getUTCMinutes() / 15) * 15; // Round down to nearest 15 minutes
  }
  currentDate.setUTCMinutes(roundedMinutes); // Set rounded minutes
  const pastDate = new Date(currentDate.getTime() - offset * 60 * 60 * 1000); // Subtract offset hours
  if (type === "short") {
    let hours = pastDate.getHours();
    const minutes = String(pastDate.getMinutes()).padStart(2, "0");
    const period = hours >= 12 ? "PM" : "AM"; // Determine AM/PM
    hours = hours % 12; // Convert hours to 12-hour format
    hours = hours ? hours : 12; // Handle midnight (0 hours)
    return `${hours}:${minutes} ${period}`;
  }

  const year = pastDate.getUTCFullYear();
  const month = String(pastDate.getUTCMonth() + 1).padStart(2, "0"); // Months are zero-based
  const day = String(pastDate.getUTCDate()).padStart(2, "0");
  const hours = String(pastDate.getUTCHours()).padStart(2, "0");
  const minutes = String(pastDate.getUTCMinutes()).padStart(2, "0");

  const formattedDate = `${year}${month}${day}`;
  const formattedTime = `${hours}${minutes}`;

  return `${formattedDate}/${formattedDate}_${formattedTime}`;
}
function formatDate(dateStr) {
  const date = new Date(dateStr);
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getDate()} ${monthNames[date.getMonth()]}`;
}
function getNextDaysMidnight(offset = 0) {
  const currentDate = new Date();
  const futureDate = new Date(
    currentDate.getTime() + offset * 24 * 60 * 60 * 1000
  );
  const year = futureDate.getUTCFullYear();
  const month = String(futureDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(futureDate.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}T00:00:00Z`;
}
// Helper function to get the latest DWD model run time
function getLatestDWDModelRun() {
  const now = new Date();
  const modelHours = [0, 6, 12, 18]; // DWD ICON runs at 00Z, 06Z, 12Z, 18Z

  // Find the most recent model run (must be at least 2-3 hours old for data availability)
  for (let hoursBack = 2; hoursBack <= 24; hoursBack++) {
    const testTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
    const testHour = testTime.getUTCHours();

    if (modelHours.includes(testHour)) {
      testTime.setUTCMinutes(0, 0, 0); // Align to exact hour
      return testTime;
    }
  }

  // Fallback: go back to last 00Z or 12Z
  const fallback = new Date(now);
  fallback.setUTCHours(now.getUTCHours() >= 12 ? 12 : 0, 0, 0, 0);
  if (fallback > now) {
    fallback.setUTCDate(fallback.getUTCDate() - 1);
  }
  return fallback;
}
// Helper function to get available satellite times (3-hour intervals)
function getLatestSatelliteTime() {
  const now = new Date();
  // Satellite data available every 3 hours: 00, 03, 06, 09, 12, 15, 18, 21 UTC
  const satelliteHours = [0, 3, 6, 9, 12, 15, 18, 21];

  // Find the most recent satellite time (must be at least 30 minutes old for processing)
  for (let hoursBack = 0.5; hoursBack <= 24; hoursBack += 0.5) {
    const testTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
    const testHour = testTime.getUTCHours();

    if (satelliteHours.includes(testHour)) {
      testTime.setUTCMinutes(0, 0, 0); // Align to exact hour
      return testTime;
    }
  }

  // Fallback: go back to last available time
  const fallback = new Date(now);
  const currentHour = fallback.getUTCHours();
  const nearestHour = satelliteHours.reduce((prev, curr) =>
    Math.abs(curr - currentHour) < Math.abs(prev - currentHour) ? curr : prev
  );
  fallback.setUTCHours(
    nearestHour <= currentHour ? nearestHour : nearestHour - 3,
    0,
    0,
    0
  );
  if (fallback > now) {
    fallback.setUTCDate(fallback.getUTCDate() - 1);
  }
  return fallback;
}
//---------------------------------------------------------------------------------------------
/******************************************************
 ----------------------------------------DWD LAYERS START---------------------------------------------
 ******************************************************/
export function generateDWDSatelliteLayers() {
  const dwdSatellite = [];

  Array.from({ length: 8 }, (_, index) => {
    const latestSatelliteTime = getLatestSatelliteTime();
    const hoursBack = (7 - index) * 3;
    const id = `dwd_satellite_ir${index + 1}`;

    const satelliteTime = new Date(
      latestSatelliteTime.getTime() - hoursBack * 60 * 60 * 1000
    );
    const satelliteISO = satelliteTime.toISOString();

    const pktTime = new Date(satelliteTime.getTime() + 5 * 60 * 60 * 1000);
    const day = String(pktTime.getUTCDate()).padStart(2, "0");
    const MONTHS = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const mon = MONTHS[pktTime.getUTCMonth()];
    const hours = pktTime.getUTCHours();
    const minutes = pktTime.getUTCMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const hours12 = hours % 12 || 12;
    const timePKT = `${String(hours12).padStart(2, "0")}:${String(
      minutes
    ).padStart(2, "0")} ${ampm}`;

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://maps.dwd.de/geoserver/dwd/ows?service=WMS&version=1.3.0&request=GetMap` +
            `&layers=dwd:Satellite_worldmosaic_3km_world_ir108_3h` +
            `&styles=satellite_worldmosaic_3km_world_ir108_3h` +
            `&bbox={bbox-epsg-3857}&width=256&height=256` +
            `&format=image/png&transparent=true&crs=EPSG:3857` +
            `&time=${satelliteISO}`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "visible" },
          paint: {
            "raster-opacity": index === 0 ? 0.75 : 0,
            "raster-fade-duration": 1000,
          },
        },
      ],
      date: `${mon} ${day} - ${timePKT}`,
    };

    dwdSatellite.push(entry);
  });

  return dwdSatellite;
}
//----------------------------------------DWD LAYERS END---------------------------------------------


/******************************************************
 ----------------------------------------ECMWF LAYERS START---------------------------------------------
 ******************************************************/
// Generate ECMWF Temperature Layers
export function generateECMWFTempLayers() {
  const ecmwfTemp = [];

  Array.from({ length: 10 }, (_, index) => {
    const idSuffixes = [
      "today",
      "onedayahead",
      "twodayahead",
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
    ];

    const id = `ecmwf_temp_${idSuffixes[index]}`;
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=t850_public&TIME=${timeParam}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            "raster-opacity-transition": { duration: 500 },
          },
        },
      ],
      date,
    };

    ecmwfTemp.push(entry);
  });

  return ecmwfTemp;
}
// Generate ECMWF Cyclone Layers
export function generateECMWFCycloneLayers() {
  const ecmwfCyclone = [];

  Array.from({ length: 6 }, (_, index) => {
    const idSuffixes = [
      "today",
      "onedayahead",
      "twodayahead",
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
    ];

    const id = `ecmwf_cyclone_${idSuffixes[index]}`;
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=genesis_td&TIME=${timeParam}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            "raster-opacity-transition": { duration: 500 },
          },
        },
      ],
      date,
    };

    ecmwfCyclone.push(entry);
  });

  return ecmwfCyclone;
}
// Generate ECMWF Lightning Layers
export function generateECMWFLightningLayers() {
  const ecmwfLight = [];

  Array.from({ length: 9 }, (_, index) => {
    const idSuffixes = [
      "today",
      "onedayahead",
      "twodayahead",
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
    ];
    const id = `ecmwf_lightning_${idSuffixes[index]}`;
    const date = getNextNDays(index - 1, "short");
    const timeParam = getNextNDays(index - 1);

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://maps.effis.emergency.copernicus.eu/gwis?LAYERS=ecmwf.extra.lightning&FORMAT=image/png&TRANSPARENT=true&SERVICE=wms&VERSION=1.1.1&REQUEST=GetMap&STYLES=&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=1439&HEIGHT=602&TIME=${timeParam}`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            "raster-opacity-transition": { duration: 500 },
          },
        },
      ],
      date,
    };

    ecmwfLight.push(entry);
  });

  return ecmwfLight;
}
//------------------------------------------------------------ ECMWF LAYERS END-------------------------------------------

//--------------- LAYER definitions and additions - Air Quality Layers Start-------------------------------------------

/***********************************************************************
 * CAMS--Air Quality Layers Start--------------------------------------------------------------------------------------------------------
 ***********************************************************************/

// PM2.5 - Particulate Matter 2.5
export function generatePM25Layers() {
  const pm25 = [];

  Array.from({ length: 5 }, (_, index) => {
    const id = `cams_composition_pm2p5${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_pm2p5&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    pm25.push(entry);
  });

  return pm25;
}
// PM10 - Particulate Matter 10
export function generatePM10Layers() {
  const pm10 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_pm10${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_pm10&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    pm10.push(entry);
  });

  return pm10;
}

// NO2 - Nitrogen Dioxide at 850hPa
export function generateNO2Layers() {
  const no2 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_no2_850hpa${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_no2_850hpa&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    no2.push(entry);
  });

  return no2;
}

// SO2 - Sulphur Dioxide (total column)
export function generateSO2Layers() {
  const so2 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_so2_totalcolumn${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_so2_totalcolumn&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    so2.push(entry);
  });

  return so2;
}

// O3 - Ozone (total column)
export function generateO3Layers() {
  const o3 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_o3_totalcolumn${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_o3_totalcolumn&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    o3.push(entry);
  });

  return o3;
}

// CO - Carbon Monoxide (total column)
export function generateCOLayers() {
  const co = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_co_totalcolumn${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_co_totalcolumn&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    co.push(entry);
  });

  return co;
}

// Dust AOD (DUAOD550) - Desert Dust Aerosol Optical Depth
export function generateDustLayers() {
  const dust = [];

  Array.from({ length: 5 }, (_, index) => {
    const id = `cams_composition_duaod550${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&STYLES=sh_Oranges_aod&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_duaod550&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    dust.push(entry);
  });

  return dust;
}

// CH4 - Methane at 300hPa
export function generateCH4300Layers() {
  const ch4300 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_ch4_300hpa${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_ch4_300hpa&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    ch4300.push(entry);
  });

  return ch4300;
}

// SUAOD550 - Sulphate Aerosol Optical Depth at 550nm
export function generateSUAOD550Layers() {
  const suaod550 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_suaod550${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_suaod550&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    suaod550.push(entry);
  });

  return suaod550;
}

// BBAOD550 - Biomass Burning Aerosol Optical Depth at 550nm
export function generateBBAOD550Layers() {
  const bbaod550 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_bbaod550${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_bbaod550&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    bbaod550.push(entry);
  });

  return bbaod550;
}

// CO2 at 850hPa - Carbon Dioxide at 850hPa
export function generateCO2_850hPaLayers() {
  const co2_850hpa = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_co2_850hpa${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_co2_850hpa&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    co2_850hpa.push(entry);
  });

  return co2_850hpa;
}

// CO2 Surface - Carbon Dioxide at Surface
export function generateCO2SurfaceLayers() {
  const co2_surface = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_co2_surface${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_co2_surface&VERSION=1.3.0&FORMAT=image/png&STYLES=sh_Spectral_r_co2_surface&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    co2_surface.push(entry);
  });

  return co2_surface;
}

// HCHO Surface - Formaldehyde at Surface
export function generateHCHOSurfaceLayers() {
  const hcho_surface = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_hcho_surface${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_hcho_surface&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    hcho_surface.push(entry);
  });

  return hcho_surface;
}

// SSAOD550 - Sea Salt Aerosol Optical Depth at 550nm
export function generateSSAOD550Layers() {
  const ssaod550 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `cams_composition_ssaod550${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_ssaod550&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    ssaod550.push(entry);
  });

  return ssaod550;
}

// UV Index Daily Max - Maximum UV Index for the Day
export function generateUVIndexDailyMaxLayers() {
  const uvindex = [];

  Array.from({ length: 4 }, (_, index) => {
    const id = `cams_composition_uvindex_daily_max${index}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_uvindex_daily_max&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-fade-duration": 500,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date: getNextNDays(index, "short"),
    };

    uvindex.push(entry);
  });

  return uvindex;
}

/***********************************************************************
 * CAMS--Air Quality Layers End----------------------------------------------------------------------------------------------------------
 ***********************************************************************/

//------------------------------------------------------------ Air Quality Layers END-------------------------------------------

/***********************************************************************
 * GDPS--Global Deterministic Prediction System (GDPS) START
 ***********************************************************************/
// Relative Humidity only
export function generateGDPSRelHumLayers() {
  const gdpsRelHumLayers = [];

  Array.from({ length: 11 }, (_, index) => {
    const idSuffixes = [
      "today", "onedayahead", "twodayahead", "threedayahead", "fourdayahead",
      "fivedayahead", "sixdayahead", "sevendayahead", "eightdayahead", 
      "ninedayahead", "tendayahead",
    ];

    const suffix = idSuffixes[index];
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDaysWithTime(index, "00", "00", "00");

    const idRelHum = `gdps_rel_hum_${suffix}`;
    const relHumEntry = {
      date,
      source: {
        id: idRelHum,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_RelativeHumidity_2m`,
        ],
      },
      layers: [
        {
          id: idRelHum,
          type: "raster",
          source: idRelHum,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            "raster-opacity-transition": { duration: 1000 },
          },
        },
      ],
    };

    gdpsRelHumLayers.push(relHumEntry); // Only push one entry
  });

  return gdpsRelHumLayers;
}

// Specific Humidity only
export function generateGDPSSpecHumLayers() {
  const gdpsSpecHumLayers = [];

  Array.from({ length: 11 }, (_, index) => {
    const idSuffixes = [
      "today", "onedayahead", "twodayahead", "threedayahead", "fourdayahead",
      "fivedayahead", "sixdayahead", "sevendayahead", "eightdayahead", 
      "ninedayahead", "tendayahead",
    ];

    const suffix = idSuffixes[index];
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDaysWithTime(index, "00", "00", "00");

    const idSpecHum = `gdps_spec_hum_${suffix}`;
    const specHumEntry = {
      date,
      source: {
        id: idSpecHum,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_SpecificHumidity_2m`,
        ],
      },
      layers: [
        {
          id: idSpecHum,
          type: "raster",
          source: idSpecHum,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            "raster-opacity-transition": { duration: 1000 },
          },
        },
      ],
    };

    gdpsSpecHumLayers.push(specHumEntry); // Only push one entry
  });

  return gdpsSpecHumLayers;
}

// Precipitation Layer (GDPS)

export function generateGDPSAccPreciLayers() {
  const gdpsAccPreci = [];

  // Iterate 10 times (index 0 to 9) to cover days 1 through 10 ahead
  Array.from({ length: 10 }, (_, index) => {
    // The relevant day index is index + 1, from 1 to 10
    const dayIndex = index + 1; 

    // Determine the ID suffix based on the day index (1 to 10)
    const idSuffixes = [
      "onedayahead", // index 0 (dayIndex 1)
      "twodayahead", // index 1 (dayIndex 2)
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
      "tendayahead", // index 9 (dayIndex 10)
    ];

    const suffix = idSuffixes[index];
    const date = getNextNDays(dayIndex, "short");
    // Use dayIndex (index + 1) for the time calculation as in the original snippet
    const timeParam = getNextNDaysWithTime(dayIndex, "00", "00", "00"); 

    // --- Accumulated Precipitation Layer Entry ---
    const idAccPreci = `gdps_acc_preci_${suffix}`; // Updated ID to use suffix
    const accPreciEntry = {
      date, // The date property is moved up one level
      source: {
        id: idAccPreci,
        type: "raster",
        tileSize: 256,
        tiles: [
          // Using dayIndex for the time parameter
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_ConvectivePrecip-Accum`,
        ],
      },
      layers: [
        {
          id: idAccPreci,
          type: "raster",
          source: idAccPreci,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Changed "raster-fade-duration" to "raster-opacity-transition"
            "raster-opacity-transition": { duration: 1000 }, 
          },
        },
      ],
    };

    // Push the entry to the final array
    gdpsAccPreci.push(accPreciEntry);
  });

  return gdpsAccPreci;
}

// Precipitation Type Layer (GDPS)
export function generateGDPSPreciTypesLayers() {
  const gdpsPreciTypes = [];

  // Arrays defining the specific time steps for the 10 layers
  const hours = ["03", "06", "09", "12", "15", "18", "21", "03", "06", "09"];
  const daysOffset = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];

  Array.from({ length: 10 }, (_, i) => {
    // The ID is based on the index + 1 (1 to 10)
    const id = `gdpsPreciTypes_${i + 1}`; 
    
    // Calculate the time parameter for the WMS tile URL
    const timeParam = getNextNDaysWithTime(daysOffset[i], hours[i], "00", "00");

    // Calculate the date property for the entry
    // Note: The original code used a function that calculates date/time based on *hours*, not days.
    const date = getNextNHoursWithTime(hours[i], "00", "00", "gmt", "short");

    // Create precipitation entry
    const hourlyPreciEntry = {
      date, // Date/time property at the top level
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_PrecipType-Significant3h`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Changed "raster-fade-duration" to "raster-opacity-transition"
            "raster-opacity-transition": { duration: 1000 },
          },
        },
      ],
    };

    // Push the entry to the final array
    gdpsPreciTypes.push(hourlyPreciEntry);
  });

  return gdpsPreciTypes;
}
// GDPS - Snow Density Weekly Forecast (kg/m³)
export function generateSnowDensityWeeklyLayers() {
  const out = [];

  Array.from({ length: 7 }, (_, index) => {
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDaysWithTime(index, "00", "00", "00");
    const sourceId = `snow_density_weekly_kgm3_forecast_${index}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_SnowDensity`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
// GDPS - Snow Depth Weekly Forecast (m)
export function generateSnowDepthWeeklyLayers() {
  const out = [];

  Array.from({ length: 7 }, (_, index) => {
    const date = getNextNDays(index, "short");
    const timeParam = getNextNDaysWithTime(index, "00", "00", "00");
    const sourceId = `snow_depth_weekly_forecast_${index}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_SnowDepth`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
// GDPS - Snowfall Hourly Forecast (Probability)
export function generateSnowfallHourlyLayers() {
  const out = [];
  const hours = ["03", "06", "09", "12", "15", "18", "21", "03", "06", "09"];
  const daysOffset = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1];

  Array.from({ length: 10 }, (_, i) => {
    const timeParam = getNextNDaysWithTime(daysOffset[i], hours[i], "00", "00");
    const date = getNextNHoursWithTime(hours[i], "00", "00", "gmt", "short");
    const sourceId = `snowfall_hourly_forecast_${i}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=CAPS-WEonG_3km_Snow-Prob`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": i === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 1000 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
//GDPS - Thunderstorm Probability 3-Hourly Forecast
export function generateThunderstormProbability3HourlyLayers() {
  const out = [];
  const hours = ["03", "06", "09", "12", "15", "18", "21", "23", "03", "06"];
  const daysOffset = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];

  Array.from({ length: 10 }, (_, i) => {
    const timeParam = getNextNDaysWithTime(daysOffset[i], hours[i], "00", "00");
    const date = getNextNHoursWithTime(hours[i], "00", "00", "gmt", "short");
    const sourceId = `thunderstorm_probability_3hourly_forecast_${i}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=CAPS-WEonG_3km_Thunderstorm-Prob`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": i === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 1000 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}

//GDPS - Liquid Fog Probability 3-Hourly Forecast (Visibility)
export function generateLiquidFogProbability3HourlyLayers() {
  const out = [];
  const hours = ["03", "06", "09", "12", "15", "18", "21", "23", "03", "06"];
  const daysOffset = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];

  Array.from({ length: 10 }, (_, i) => {
    const timeParam = getNextNDaysWithTime(daysOffset[i], hours[i], "00", "00");
    const date = getNextNHoursWithTime(hours[i], "00", "00", "gmt", "short");
    const sourceId = `liquid_fog_probability_3hourly_forecast_${i}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=CAPS-WEonG_3km_LiquidFogVisibility`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": i === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 1000 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
//GDPS - Convective Precipitation Weekly Forecast (kg/m²)
export function generateConvectivePrecipitationWeeklyLayers() {
  const out = [];

  Array.from({ length: 10 }, (_, index) => {
    const date = getNextNDays(index + 1, "short");
    const timeParam = getNextNDaysWithTime(index + 1, "00", "00", "00");
    const sourceId = `convective_precipitation_weekly_kgm2_forecast_${index + 1}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS_15km_ConvectivePrecip-Accum`,
        ],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          paint: {
            "raster-opacity": index === 0 ? 1 : 0,
            "raster-opacity-transition": { duration: 500 },
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}

// Ocean Salinity Layers
export function generateOceanSalinityLayers() {
  const oceanSalinityLayers = [];

  // Iterate 10 times (index 0 to 9) to cover days 1 through 10 ahead
  Array.from({ length: 10 }, (_, index) => {
    // The relevant day index is index + 1, from 1 to 10
    const dayIndex = index + 1; 

    // Determine the ID suffix based on the day index (1 to 10)
    const idSuffixes = [
      "onedayahead", // index 0 (dayIndex 1)
      "twodayahead", // index 1 (dayIndex 2)
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
      "tendayahead", // index 9 (dayIndex 10)
    ];

    const suffix = idSuffixes[index];
    // The original ID was numeric, but we'll use the descriptive suffix for consistency with the new pattern
    const id = `Sea_Water_salinity_10m_forecast_${suffix}`; 
    const date = getNextNDays(dayIndex, "short");
    // Use dayIndex (index + 1) for the time calculation as in the original snippet
    const timeParam = getNextNDaysWithTime(dayIndex, "00", "00", "00"); 

    // --- Ocean Salinity Layer Entry ---
    const oceanSalEntry = {
      date, // The date property is moved up one level
      source: {
        id,
        type: "raster",
        // Note: tileSize was missing in the original snippet, assuming 256 for consistency
        tileSize: 256, 
        tiles: [
          // Using dayIndex for the time parameter
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=OCEAN.GIOPS.3D_SALW_0010`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Keeping the correct "raster-opacity-transition" property and removing the redundant "raster-fade-duration"
            "raster-opacity-transition": { duration: 500 }, 
          },
        },
      ],
    };

    // Push the entry to the final array
    oceanSalinityLayers.push(oceanSalEntry);
  });

  return oceanSalinityLayers;
}

// Ocean Temperature Layers
export function generateOceanTemperatureLayers() {
  const oceanTempLayers = [];

  // Iterate 10 times (index 0 to 9) to cover days 1 through 10 ahead
  Array.from({ length: 10 }, (_, index) => {
    // The relevant day index is index + 1, from 1 to 10
    const dayIndex = index + 1; 

    // Determine the ID suffix based on the day index (1 to 10)
    const idSuffixes = [
      "onedayahead", // index 0 (dayIndex 1)
      "twodayahead", 
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
      "tendayahead", // index 9 (dayIndex 10)
    ];

    const suffix = idSuffixes[index];
    // Use the descriptive suffix for the ID
    const id = `Sea_Water_temp_10m_forecast_${suffix}`; 
    const date = getNextNDays(dayIndex, "short");
    // Use dayIndex (index + 1) for the time calculation as in the original snippet
    const timeParam = getNextNDaysWithTime(dayIndex, "00", "00", "00"); 

    // --- Ocean Temperature Layer Entry ---
    const oceanTempEntry = {
      date, // The date property is moved up one level
      source: {
        id,
        type: "raster",
        // Adding tileSize for consistency, assuming 256
        tileSize: 256, 
        tiles: [
          // Using timeParam
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=OCEAN.GIOPS.3D_TM2_0010`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Keeping the correct "raster-opacity-transition" property and removing the redundant "raster-fade-duration"
            "raster-opacity-transition": { duration: 500 }, 
          },
        },
      ],
    };

    // Push the entry to the final array
    oceanTempLayers.push(oceanTempEntry);
  });

  return oceanTempLayers;
}

//Ocean Currents Layers
export function generateOceanCurrentsLayers() {
  const oceanCurrentsLayers = [];

  // Iterate 10 times (index 0 to 9) to cover days 1 through 10 ahead
  Array.from({ length: 10 }, (_, index) => {
    // The relevant day index is index + 1, from 1 to 10
    const dayIndex = index + 1; 

    // Determine the ID suffix based on the day index (1 to 10)
    const idSuffixes = [
      "onedayahead", // index 0 (dayIndex 1)
      "twodayahead", 
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
      "tendayahead", // index 9 (dayIndex 10)
    ];

    const suffix = idSuffixes[index];
    // Use the descriptive suffix for the ID
    const id = `Sea_Water_Potential_currents_10m_forecast_${suffix}`; 
    const date = getNextNDays(dayIndex, "short");
    // Use dayIndex (index + 1) for the time calculation as in the original snippet
    const timeParam = getNextNDaysWithTime(dayIndex, "00", "00", "00"); 

    // --- Ocean Surface Currents Layer Entry ---
    const oceanSurCurEntry = {
      date, // The date property is moved up one level
      source: {
        id,
        type: "raster",
        // Adding tileSize for consistency, assuming 256
        tileSize: 256, 
        tiles: [
          // Using timeParam
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=OCEAN.GIOPS.3D_UU2W_0010`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Keeping the correct "raster-opacity-transition" property and removing the redundant "raster-fade-duration"
            "raster-opacity-transition": { duration: 500 }, 
          },
        },
      ],
    };

    // Push the entry to the final array
    oceanCurrentsLayers.push(oceanSurCurEntry);
  });

  return oceanCurrentsLayers;
}

// Ocean Surface Height Layers
export function generateOceanSurfaceHeightLayers() {
  const oceanSurfaceHeightLayers = [];

  // Iterate 10 times (index 0 to 9) to cover days 1 through 10 ahead
  Array.from({ length: 10 }, (_, index) => {
    // The relevant day index is index + 1, from 1 to 10
    const dayIndex = index + 1; 

    // Determine the ID suffix based on the day index (1 to 10)
    const idSuffixes = [
      "onedayahead", // index 0 (dayIndex 1)
      "twodayahead", 
      "threedayahead",
      "fourdayahead",
      "fivedayahead",
      "sixdayahead",
      "sevendayahead",
      "eightdayahead",
      "ninedayahead",
      "tendayahead", // index 9 (dayIndex 10)
    ];

    const suffix = idSuffixes[index];
    // Use the descriptive suffix for the ID
    const id = `Sea_Water_Potential_Height_2mgeoid_forecast_${suffix}`; 
    const date = getNextNDays(dayIndex, "short");
    // Use dayIndex (index + 1) for the time calculation as in the original snippet
    const timeParam = getNextNDaysWithTime(dayIndex, "00", "00", "00"); 

    // --- Ocean Surface Height Layer Entry ---
    const oceanSurHeightEntry = {
      date, // The date property is moved up one level
      source: {
        id,
        type: "raster",
        // Adding tileSize for consistency, assuming 256
        tileSize: 256, 
        tiles: [
          // Using timeParam
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=OCEAN.GIOPS.2D_SSH`,
        ],
      },
      layers: [
        {
          id,
          type: "raster",
          source: id,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": 1,
            // Keeping the correct "raster-opacity-transition" property and removing the redundant "raster-fade-duration"
            "raster-opacity-transition": { duration: 500 }, 
          },
        },
      ],
    };

    // Push the entry to the final array
    oceanSurfaceHeightLayers.push(oceanSurHeightEntry);
  });

  return oceanSurfaceHeightLayers;
}
//---------------------------------------GDPS END--------------------------------------------------
//--------------- LAYER definitions and additions - Air Quality Layers END-------------------------------------------
/******************************************************
 * SUFFIX HELPERS (consistent, conflict-free naming)
 ******************************************************/
const MBX_DAY_SUFFIXES = [
  "today",
  "onedayahead",
  "twodayahead",
  "threedayahead",
  "fourdayahead",
  "fivedayahead",
  "sixdayahead",
  "sevendayahead",
];

const MBX_HOUR_SUFFIXES = [
  "now",
  "onehourahead",
  "twohourahead",
  "threehourahead",
  "fourhourahead",
  "fivehourahead",
  "sixhourahead",
  "sevenhourahead",
  "eighthourahead",
  "ninehourahead",
  "tenhourahead",
  "elevenhourahead",
];
//METEOBLUE LAYERS --------------------------------------------
/***********************************************************************
 * 1) Meteoblue Daily: CloudsLow / CloudsMid / Precip / Snow (vector)
 ***********************************************************************/
export function generateMeteoblueNEMSCloudPrecipLayers(model, metbluT) {
  const result = [];

  const idSuffixes = [
    "today",
    "onedayahead",
    "twodayahead",
    "threedayahead",
    "fourdayahead",
    "fivedayahead",
    "sixdayahead",
    "sevendayahead",
  ];

  Array.from({ length: 8 }, (_, index) => {
    const date = getNextNDays(index, "short");
    const time = getNextDaysMidnight(index);

    const sourceId = `meteoblue_nems_cloudprecipitation_forecast_${idSuffixes[index]}`;

    // NOTE: same URL you provided, just parameterized with model/time/key.
    const baseUrl = `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}/cloudsLow~73~low%20cld%20lay~daily~mean~contourSteps~20.0~40.0~60.0~80.0~95.0_cloudsMid~74~mid%20cld%20lay~daily~mean~contourSteps~20.0~40.0~60.0~80.0~95.0_precip~61~sfc~daily~sum~contourSteps~1~2~3~4~5~6~8~10~12~16~18~20~25~30~35~40~50~60~70~80~90~100~125~150_snow~679~sfc~daily~sum~contourSteps~1~5~10~20~30/{z}/{x}/{y}?apikey=${metbluT}`;

    const entry = {
      source: {
        id: sourceId,
        type: "vector",
        tiles: [baseUrl],
      },
      layers: [
        // Low clouds
        {
          id: `meteoblue_nems_cloudlow_forecast_${idSuffixes[index]}`,
          type: "fill",
          source: sourceId,
          "source-layer": "cloudsLow",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": index === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0, "rgba(255,255,255,0.0)",
              20, "rgba(255,255,255,0.2)",
              40, "rgba(255,255,255,0.3)",
              60, "rgba(255,255,255,0.5)",
              80, "rgba(255,255,255,0.8)",
              95, "rgba(255,255,255,0.9)"
            ]
          },
        },

        // Mid clouds
        {
          id: `meteoblue_nems_cloudmid_forecast_${idSuffixes[index]}`,
          type: "fill",
          source: sourceId,
          "source-layer": "cloudsMid",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": index === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0, "rgba(255,255,255,0.0)",
              20, "rgba(255,255,255,0.2)",
              40, "rgba(255,255,255,0.3)",
              60, "rgba(255,255,255,0.5)",
              80, "rgba(255,255,255,0.8)",
              95, "rgba(255,255,255,0.9)"
            ]
          },
        },

        // Precipitation (daily sum scale you provided)
        {
          id: `meteoblue_nems_precipitation_forecast_${idSuffixes[index]}`,
          type: "fill",
          source: sourceId,
          "source-layer": "precip",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": index === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              1, "rgba(240,249,255,1.0)",
              2, "rgba(222,243,252,1.0)",
              3, "rgba(191,235,250,1.0)",
              4, "rgba(160,225,248,1.0)",
              5, "rgba(133,217,246,1.0)",
              6, "rgba(110,200,242,1.0)",
              8, "rgba(82,176,237,1.0)",
              10, "rgba(64,149,230,1.0)",
              12, "rgba(49,136,227,1.0)",
              16, "rgba(33,121,223,1.0)",
              18, "rgba(29,156,109,1.0)",
              20, "rgba(26,178,64,1.0)",
              25, "rgba(111,201,54,1.0)",
              30, "rgba(173,230,47,1.0)",
              35, "rgba(209,242,46,1.0)",
              40, "rgba(247,250,46,1.0)",
              50, "rgba(250,213,41,1.0)",
              60, "rgba(252,176,36,1.0)",
              70, "rgba(250,141,38,1.0)",
              80, "rgba(249,102,35,1.0)",
              90, "rgba(246,66,35,1.0)",
              100, "rgba(243,33,33,1.0)",
              125, "rgba(216,0,117,1.0)",
              150, "rgba(166,0,157,1.0)"
            ]
          },
        },

        // Snow (pattern assumes your sprite contains "snowPattern")
        {
          id: `meteoblue_nems_snow_forecast_${idSuffixes[index]}`,
          type: "fill",
          source: sourceId,
          "source-layer": "snow",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-pattern": "snowPattern",
          },
        },
      ],
      date,
    };

    result.push(entry);
  });

  return result;
}
/***********************************************************************
 * 2) Meteoblue Hourly: CloudsLow / CloudsMid / Precip / Snow (vector)
 ***********************************************************************/
export function generateMBX_MeteoblueHourlyCloudPrecipLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 11 }, (_, hourOffset) => {
    const time = getNextNHoursWithTime(hourOffset);
    const date = getPastHours(-hourOffset, "short");
    const suffix = MBX_HOUR_SUFFIXES[hourOffset]; // 0..10 → now..tenhourahead
    const sourceId = `mbx_nems_cloudprecip_hourly_${suffix}`;

    const baseUrl =
      `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
      `/cloudsLow~73~low%20cld%20lay~hourly~none~contourSteps~20.0~40.0~60.0~80.0~95.0` +
      `_cloudsMid~74~mid%20cld%20lay~hourly~none~contourSteps~20.0~40.0~60.0~80.0~95.0` +
      `_precip~61~sfc~hourly~none~contourSteps~0.1~0.25~0.5~1.0~1.5~2.0~3.0~5.0~7.0~10.0~15.0~20.0~30.0` +
      `_snow~679~sfc~hourly~none~contourSteps~0.2/{z}/{x}/{y}?apikey=${metbluT}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [baseUrl],
      },
      layers: [
        {
          id: `mbx_nems_cloudlow_hourly_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "cloudsLow",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0, "rgba(255,255,255,0.0)",
              20, "rgba(255,255,255,0.2)",
              40, "rgba(255,255,255,0.3)",
              60, "rgba(255,255,255,0.5)",
              80, "rgba(255,255,255,0.8)",
              95, "rgba(255,255,255,0.9)"
            ]
          },
        },
        {
          id: `mbx_nems_cloudmid_hourly_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "cloudsMid",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0, "rgba(255,255,255,0.0)",
              20, "rgba(255,255,255,0.2)",
              40, "rgba(255,255,255,0.3)",
              60, "rgba(255,255,255,0.5)",
              80, "rgba(255,255,255,0.8)",
              95, "rgba(255,255,255,0.9)"
            ]
          },
        },
        {
          id: `mbx_nems_precip_hourly_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "precip",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0.1, "rgba(133,247,244,0.5)",
              0.25, "rgba(133,247,244,1.0)",
              0.5, "rgba(105,148,252,1.0)",
              1, "rgba(90,123,248,1.0)",
              1.5, "rgba(1,124,254,1.0)",
              2, "rgba(2,104,213,1.0)",
              3, "rgba(3,151,135,1.0)",
              5, "rgba(2,198,33,1.0)",
              7, "rgba(174,255,3,1.0)",
              10, "rgba(218,255,53,1.0)",
              15, "rgba(255,173,2,1.0)",
              20, "rgba(255,97,1,1.0)",
              25, "rgba(252,60,3,1.0)",
              30, "rgba(251,20,3,1.0)"
            ]
          },
        },
        {
          id: `mbx_nems_snow_hourly_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "layerSnow", // original name kept
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-pattern": "snowPattern",
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 3) Meteoblue “Daily Max Temperature” (vector, 8 entries)
 *    Kept under the same exported function name for compatibility.
 ***********************************************************************/
export function generateMBX_MeteoblueHourlyTemperatureLayers(model, level, metbluT) {
  const out = [];

  Array.from({ length: 8 }, (_, index) => {
    const date = getNextNDays(index, "short");
    const time = getNextDaysMidnight(index);
    const suffix = MBX_DAY_SUFFIXES[index];
    const sourceId = `mbx_temp_hourly_${suffix}`;

    const url =
      `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
      `/temperatureColortable~11~${level}~daily~max~contourSteps~-100.0~-80.0~-75.0~-70.0~-65.0~-60.0~-55.0~-50.0~-45.0~-40.0~-35.0~-32.0~-30.0~-28.0~-26.0~-24.0~-22.0~-20.0~-18.0~-16.0~-14.0~-12.0~-10.0~-8.0~-6.0~-4.0~-2.0~0.0~2.0~4.0~6.0~8.0~10.0~12.0~14.0~16.0~18.0~20.0~22.0~24.0~26.0~28.0~30.0~32.0~34.0~36.0~38.0~40.0~42.0~44.0~46.0/{z}/{x}/{y}` +
      `?temperatureUnit=C&apikey=${metbluT}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [url],
      },
      layers: [
        {
          id: `mbx_temp_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "temperatureColortable",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": index === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              -100, "rgba(28, 55, 138, 1.0)",
              -80, "rgba(38, 79, 172, 1.0)",
              -60, "rgba(52, 140, 237, 1.0)",
              -40, "rgba(68, 177, 246, 1.0)",
              -20, "rgba(81, 203, 250, 1.0)",
              -10, "rgba(128, 224, 247, 1.0)",
              -2, "rgba(160, 234, 247, 1.0)",
              0, "rgba(0, 239, 124, 1.0)",
              6, "rgba(0, 200, 72, 1.0)",
              12, "rgba(60, 161, 44, 1.0)",
              18, "rgba(181, 255, 51, 1.0)",
              24, "rgba(255, 246, 0, 1.0)",
              30, "rgba(255, 182, 0, 1.0)",
              36, "rgba(255, 107, 0, 1.0)",
              42, "rgba(255, 46, 46, 1.0)",
              46, "rgba(243, 22, 194, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 4) Meteoblue “Radar Composite” (raster x2 per step)
 *    Note: returns `sources` (plural) for composite use-case.
 ***********************************************************************/
export function generateMBX_MeteoblueRadarCompositeLayers(metbluT) {
  const out = [];

  // hour = 11..0 (11h past → now)
  Array.from({ length: 12 }, (_, i) => {
    const hour = 11 - i;
    const date = getPastHours(hour, "short");

    const hourNames = ["", "one", "two", "three", "four", "five", "six",
      "seven", "eight", "nine", "ten", "eleven"];
    const hourName = hour === 0 ? "" : `${hourNames[hour]}hour`;
    const suffix = hour === 0 ? "" : "past";

    const precipId = `mbx_radar_precip_global_${hourName}${suffix}`;
    const satId = `mbx_satellite_global_${hourName}${suffix}`;

    const precipUrl =
      `https://maps-api.meteoblue.com/v1/tiles/precipitation_global/${getPastHours(hour)}/{z}/{x}/{y}.png?apikey=${metbluT}`;
    const satUrl =
      `https://maps-api.meteoblue.com/v1/tiles/satellite_global/${getPastHours(hour)}/{z}/{x}/{y}.jpg?apikey=${metbluT}`;

    out.push({
      sources: [
        { id: precipId, type: "raster", tiles: [precipUrl] },
        { id: satId, type: "raster", tiles: [satUrl] },
      ],
      layers: [
        {
          id: satId,
          type: "raster",
          source: satId,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": hour === 11 ? 0.2 : 0,
            "raster-opacity-transition": { duration: 500 },
          },
        },
        {
          id: precipId,
          type: "raster",
          source: precipId,
          layout: { visibility: "none" },
          paint: {
            "raster-opacity": hour === 11 ? 0.5 : 0,
            "raster-opacity-transition": { duration: 500 },
          },
        },
      ],
      date,
      metadata: {
        hour,
        hasComposite: true,
        precipitationId: precipId,
        satelliteId: satId,
      },
    });
  });

  return out;
}

/***********************************************************************
 * 5) Meteoblue Snowfall (Hourly, vector)
 ***********************************************************************/
export function generateMBX_MeteoblueSnowfallHourlyLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, hourOffset) => {
    const time = getNextNHoursWithTime(hourOffset);
    const date = getPastHours(-hourOffset, "short");
    const suffix = MBX_HOUR_SUFFIXES[hourOffset];
    const sourceId = `mbx_snowfall_hourly_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/snow~679~sfc~hourly~none~contourSteps~0.1~0.5~1~2~4~8~12~16~20~25~30~40~50~70~90~110~140/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: `mbx_snowfall_hourly_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "snow",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0.1, "rgba(230, 250, 255, 0.8)",
              0.5, "rgba(191, 236, 243, 1.0)",
              1, "rgba(156, 227, 242, 1.0)",
              2, "rgba(113, 207, 240, 1.0)",
              4, "rgba(84, 193, 238, 1.0)",
              8, "rgba(63, 181, 237, 1.0)",
              12, "rgba(43, 168, 229, 1.0)",
              16, "rgba(22, 150, 218, 1.0)",
              20, "rgba(28, 133, 207, 1.0)",
              25, "rgba(90, 123, 248, 1.0)",
              30, "rgba(134, 111, 250, 1.0)",
              40, "rgba(170, 100, 245, 1.0)",
              50, "rgba(200, 85, 230, 1.0)",
              70, "rgba(215, 65, 200, 1.0)",
              90, "rgba(230, 50, 160, 1.0)",
              110, "rgba(245, 35, 120, 1.0)",
              140, "rgba(255, 20, 80, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 6) Meteoblue CAPE (Hourly, vector)
 ***********************************************************************/
export function generateMBX_MeteoblueCAPEHourlyLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, hourOffset) => {
    const time = getNextNHoursWithTime(hourOffset);
    const date = getPastHours(-hourOffset, "short");
    const suffix = MBX_HOUR_SUFFIXES[hourOffset];
    const sourceId = `mbx_cape_hourly_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/layerCAPEInternal~157~180-0%20mb%20above%20gnd~hourly~none` +
          `~contourSteps~25.0~75.0~125.0~250.0~500.0~750.0~1000.0~1250.0~1500.0~1750.0~2000.0~2250.0~2500.0~2750.0~3000.0~3250.0~3500.0~4000.0~4500.0~5000.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: `mbx_cape_hourly_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "layerCAPEInternal",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              25, "rgba(180, 170, 255, 0.8)",
              75, "rgba(130, 120, 255, 1.0)",
              125, "rgba(90, 140, 255, 1.0)",
              250, "rgba(60, 170, 255, 1.0)",
              500, "rgba(0, 200, 255, 1.0)",
              750, "rgba(0, 220, 200, 1.0)",
              1000, "rgba(0, 210, 120, 1.0)",
              1250, "rgba(140, 230, 60, 1.0)",
              1500, "rgba(230, 230, 40, 1.0)",
              1750, "rgba(255, 210, 40, 1.0)",
              2000, "rgba(255, 180, 30, 1.0)",
              2250, "rgba(255, 150, 20, 1.0)",
              2500, "rgba(255, 120, 10, 1.0)",
              2750, "rgba(255, 90, 0, 1.0)",
              3000, "rgba(255, 60, 0, 1.0)",
              3250, "rgba(255, 30, 0, 1.0)",
              3500, "rgba(255, 0, 0, 1.0)",
              4000, "rgba(240, 0, 0, 1.0)",
              4500, "rgba(230, 0, 0, 1.0)",
              5000, "rgba(0, 255, 255, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 7) Meteoblue Storm Helicity (Hourly, vector)
 ***********************************************************************/
export function generateMBX_MeteoblueStormHelicityHourlyLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, hourOffset) => {
    const time = getNextNHoursWithTime(hourOffset);
    const date = getPastHours(-hourOffset, "short");
    const suffix = MBX_HOUR_SUFFIXES[hourOffset];
    const sourceId = `mbx_stormhelicity_hourly_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api-cdn.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/stormhelicityColortable~190~3000-0%20m%20above%20gnd~hourly~none` +
          `~contourSteps~100.0~150.0~200.0~250.0~300.0~400.0~600.0~800.0~1000.0/{z}/{x}/{y}` +
          `?temperatureUnit=C&velocityUnit=km%2Fh&lengthUnit=metric&energyUnit=watts&internal=true&apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: `mbx_stormhelicity_hourly_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "stormhelicityColortable",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": hourOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              100, "rgba(255, 255, 255, 0.1)",
              150, "rgba(180, 255, 180, 0.6)",
              200, "rgba(120, 255, 120, 0.7)",
              250, "rgba(60, 240, 60, 0.8)",
              300, "rgba(255, 255, 0, 0.8)",
              400, "rgba(255, 200, 0, 0.9)",
              600, "rgba(255, 150, 0, 1.0)",
              800, "rgba(255, 100, 0, 1.0)",
              1000, "rgba(255, 0, 0, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 8) Meteoblue Snowfall (Daily, vector)
 ***********************************************************************/
export function generateMBX_MeteoblueDailySnowfallLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 8 }, (_, dayOffset) => {
    const time = getNextDaysMidnight(dayOffset);
    const date = getNextNDays(dayOffset, "short");
    const suffix = MBX_DAY_SUFFIXES[dayOffset];
    const sourceId = `mbx_snowfall_daily_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/snow~679~sfc~daily~sum~contourSteps~0.1~0.5~1~2~4~8~12~16~20~30~50~75~105~150~200~270~360/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: `mbx_snowfall_daily_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "snow",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": dayOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              0.1, "rgba(230, 250, 255, 0.8)",
              0.5, "rgba(191, 236, 243, 1.0)",
              1, "rgba(156, 227, 242, 1.0)",
              2, "rgba(113, 207, 240, 1.0)",
              4, "rgba(84, 193, 238, 1.0)",
              8, "rgba(63, 181, 237, 1.0)",
              12, "rgba(43, 168, 229, 1.0)",
              16, "rgba(22, 150, 218, 1.0)",
              20, "rgba(28, 133, 207, 1.0)",
              30, "rgba(90, 123, 248, 1.0)",
              50, "rgba(134, 111, 250, 1.0)",
              75, "rgba(170, 100, 245, 1.0)",
              105, "rgba(200, 85, 230, 1.0)",
              150, "rgba(215, 65, 200, 1.0)",
              200, "rgba(230, 50, 160, 1.0)",
              270, "rgba(245, 35, 120, 1.0)",
              360, "rgba(255, 20, 80, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 9) Meteoblue CAPE (Daily, vector)
 ***********************************************************************/
export function generateMBX_MeteoblueDailyCAPELayers(model, metbluT) {
  const out = [];

  Array.from({ length: 8 }, (_, dayOffset) => {
    const time = getNextDaysMidnight(dayOffset);
    const date = getNextNDays(dayOffset, "short");
    const suffix = MBX_DAY_SUFFIXES[dayOffset];
    const sourceId = `mbx_cape_daily_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/layerCAPEInternal~157~180-0%20mb%20above%20gnd~daily~max` +
          `~contourSteps~25.0~75.0~125.0~250.0~500.0~750.0~1000.0~1250.0~1500.0~1750.0~2000.0~2250.0~2500.0~2750.0~3000.0~3250.0~3500.0~4000.0~4500.0~5000.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: `mbx_cape_daily_layer_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "layerCAPEInternal",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": dayOffset === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              25, "rgba(180, 170, 255, 0.8)",
              75, "rgba(130, 120, 255, 1.0)",
              125, "rgba(90, 140, 255, 1.0)",
              250, "rgba(60, 170, 255, 1.0)",
              500, "rgba(0, 200, 255, 1.0)",
              750, "rgba(0, 220, 200, 1.0)",
              1000, "rgba(0, 210, 120, 1.0)",
              1250, "rgba(140, 230, 60, 1.0)",
              1500, "rgba(230, 230, 40, 1.0)",
              1750, "rgba(255, 210, 40, 1.0)",
              2000, "rgba(255, 180, 30, 1.0)",
              2250, "rgba(255, 150, 20, 1.0)",
              2500, "rgba(255, 120, 10, 1.0)",
              2750, "rgba(255, 90, 0, 1.0)",
              3000, "rgba(255, 60, 0, 1.0)",
              3250, "rgba(255, 30, 0, 1.0)",
              3500, "rgba(255, 0, 0, 1.0)",
              4000, "rgba(240, 0, 0, 1.0)",
              4500, "rgba(230, 0, 0, 1.0)",
              5000, "rgba(0, 255, 255, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 10) Official Weather Warnings (4 static buckets)
 *    Note: includes .images on the first entry (as in your source)
 ***********************************************************************/
export function generateMBX_MeteoblueOfficialWeatherWarningsLayers(metbluT) {
  const out = [];
  const types = ["all", "24h", "24_48h", "48h_plus"];
  const names = ["all", "24h", "24_48h", "48h_plus"];
  const dates = [
    "All Warnings",
    "Next 24 Hours",
    "24-48 Hours",
    "Beyond 48 Hours",
  ];
  const urls = ["all", "%3C24h", "24-48h", "%3E48h"];

  Array.from({ length: 4 }, (_, index) => {
    const sourceId = `mbx_official_weather_warnings_${types[index]}`;
    const layerSuffix = names[index];

    const entry = {
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://warnings-api.meteoblue.com/warnings/tiles/${urls[index]}/{z}/{x}/{y}.pbf?t=${metbluT}`,
        ],
      },
      layers: [
        // Polygons
        {
          id: `mbx_weather_warnings_polygons_${layerSuffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "weatherwarnings",
          filter: ["==", "$type", "Polygon"],
          layout: { visibility: "none" },
          paint: {
            "fill-color": [
              "match",
              ["get", "severity"],
              "Extreme",
              "rgba(255, 0,   0,   0.6)",
              "Severe",
              "rgba(255, 125, 0,   0.6)",
              "Moderate",
              "rgba(252, 231, 0,   0.6)",
              "Minor",
              "rgba(215, 255, 0,   0.6)",
              /* default */ "rgba(112,112,112,0.6)",
            ],
            "fill-outline-color": "rgba(200, 100, 240, 1)",
            "fill-antialias": true,
            "fill-opacity": index === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
          },
        },
        // Points
        {
          id: `mbx_weather_warnings_points_${layerSuffix}`,
          type: "circle",
          source: sourceId,
          "source-layer": "weatherwarnings",
          filter: ["==", "$type", "Point"],
          layout: { visibility: "none" },
          paint: {
            "circle-radius": 6,
            "circle-color": "#B42222",
            "circle-opacity": index === 0 ? 1 : 0,
            "circle-opacity-transition": { duration: 500 },
          },
        },
        // Icons
        {
          id: `mbx_weather_warnings_icons_${layerSuffix}`,
          type: "symbol",
          source: sourceId,
          "source-layer": "weatherwarnings",
          filter: ["==", "$type", "Polygon"],
          minzoom: 2,
          layout: {
            "icon-size": 0.25,
            "icon-image": [
              "match",
              ["get", "main_type"],
              "Wind",
              "wind",
              "Snow",
              "snow",
              "Thunder",
              "thunderstorm",
              "LowVis",
              "fog",
              "Heat",
              "high-temp",
              "Cold",
              "low-temp",
              "Coastal",
              "coastal",
              "Forestfires",
              "fire",
              "Avalanches",
              "avalanche",
              "Rain",
              "rain",
              "Flood",
              "rain",
              "Hail",
              "snow",
              "Geological",
              "avalanche",
              "AirQuality",
              "fog",
              "Volcanic",
              "volcanic",
              "Earthquake",
              "earthquake",
              /* default */ "",
            ],
            "text-font": ["Noto Sans Regular"],
            "icon-allow-overlap": false,
            visibility: "none",
          },
          paint: {
            "icon-opacity": index === 0 ? 1 : 0,
            "icon-opacity-transition": { duration: 500 },
          },
        },
      ],
      date: dates[index],
      ...(index === 0 && {
        images: [
          {
            name: "wind",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at01.png",
          },
          {
            name: "snow",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at02.png",
          },
          {
            name: "thunderstorm",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at03.png",
          },
          {
            name: "fog",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at04.png",
          },
          {
            name: "high-temp",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at05.png",
          },
          {
            name: "low-temp",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at06.png",
          },
          {
            name: "coastal",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at07.png",
          },
          {
            name: "fire",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at08.png",
          },
          {
            name: "avalanche",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at09.png",
          },
          {
            name: "rain",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at10.png",
          },
          {
            name: "earthquake",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at11.png",
          },
          {
            name: "volcanic",
            url: "https://maps-api-cdn.meteoblue.com/warning_icons/at12.png",
          },
        ],
      }),
    };

    // ✅ push into the output array
    out.push(entry);
  });

  // ✅ close the function with "}" (not "})")
  return out;
}

/***********************************************************************
 * 11) Forecast Warnings (Daily Risk: wind + precip risk)
 ***********************************************************************/
export function generateMBX_MeteoblueForecastWarningsDailyLayers(model, metbluT) {
  const out = [];

  Array.from({ length: 8 }, (_, dayOffset) => {
    const time = getNextDaysMidnight(dayOffset, "date");
    const date = getNextNDays(dayOffset, "short");
    const suffix = MBX_DAY_SUFFIXES[dayOffset];
    const sourceId = `mbx_forecast_warnings_daily_${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api-cdn.meteoblue.com/v1/map/vector/${model}/${time}` +
          `/layerriskInternal~61~sfc~daily~sum~contourSteps~40.0~60.0~90.0` +
          `_layerWindInternal~180~sfc~daily~max~contourSteps~60.0~80.0~110.0/{z}/{x}/{y}` +
          `?temperatureUnit=C&velocityUnit=km%2Fh&lengthUnit=metric&energyUnit=watts&internal=true&apikey=${metbluT}`,
        ],
      },
      layers: [
        // Wind risk (yellows/reds)
        {
          id: `mbx_wind_risk_daily_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "layerWindInternal",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": dayOffset === 0 ? 0.7 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              60, "rgba(248, 246, 0, 1.0)",
              80, "rgba(255, 173, 0, 1.0)",
              110, "rgba(255, 26, 0, 1.0)"
            ],
          },
        },
        // Precip risk (blues/purples)
        {
          id: `mbx_precip_risk_daily_${suffix}`,
          type: "fill",
          source: sourceId,
          "source-layer": "layerriskInternal",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": dayOffset === 0 ? 0.55 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              40, "rgba(145, 201, 255, 1.0)",
              60, "rgba(157, 121, 210, 1.0)",
              90, "rgba(148, 0, 166, 1.0)"
            ],
          },
        },
      ],
      date,
    });
  });

  return out;
}

/***********************************************************************
 * 12) Meteoblue LHASA2 (Latest Daily, static raster+vector)
 ***********************************************************************/
export function generateMBX_MeteoblueLHASA2LatestLayer(metbluT) {
  const fallbackTime = getCurrentUtcDateCompact(-1);
  const latestTime = getLatestMeteoblueTimeSync(
    `https://maps-api-cdn.meteoblue.com/v1/time/daily/LHASA2?lang=en&apikey=${metbluT}`,
    fallbackTime
  );

  const commonQuery =
    `temperatureUnit=C&velocityUnit=km%2Fh&lengthUnit=metric&energyUnit=watts&internal=true&apikey=${metbluT}`;

  return {
    source: {
      id: "meteoblue_lhasa2_daily_raster_source",
      type: "raster",
      tileSize: 512,
      minzoom: 0,
      maxzoom: 6,
      tiles: [
        `https://maps-api-cdn.meteoblue.com/v1/map/raster/LHASA2/${latestTime}` +
          `/963~sfc~daily~none~contourSteps~-0.1~rgba(251,251,242,1.0)~5.0~rgba(255,255,224,1.0)~10.0~rgba(236,252,163,1.0)~20.0~rgba(226,244,111,1.0)~30.0~rgba(227,229,67,1.0)~40.0~rgba(237,208,27,1.0)~50.0~rgba(255,179,0,1.0)~60.0~rgba(255,138,11,1.0)~70.0~rgba(253,104,32,1.0)~80.0~rgba(246,80,53,1.0)~90.0~rgba(236,71,76,1.0)~100.0~rgba(223,79,108,1.0)/{z}/{x}/{y}?${commonQuery}`,
      ],
    },
    layers: [
      {
        id: "meteoblue_lhasa2_daily_raster",
        type: "raster",
        minzoom: 0,
        maxzoom: 22,
        paint: {
          "raster-opacity": 0.75,
          "raster-fade-duration": 0,
        },
      },
    ],
    latestTime,
  };
}
/***********************************************************************
 * Meteoblue CAMS - Air Quality Index (AQI) Hourly Forecast
 * 12 hourly frames
 ***********************************************************************/
export function generateMeteoblueCAMSAirQualityHourlyLayers(metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, i) => {
    const timeParam = getNextNHoursWithTime(i);
    const date = getPastHours(-i, "short");
    const suffix = i === 0 ? "" : `_${['onehourahead', 'twohourahead', 'threehourahead', 'fourhourahead', 'fivehourahead', 'sixhourahead', 'sevenhourahead', 'eighthourahead', 'ninehourahead', 'tenhourahead', 'elevenhourahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_airquality_hourly_forecast${suffix}`;
    const layerId = `meteoblue_cams_airquality_hourly${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/aqiColortable~706~sfc~hourly~none~contourSteps~-10.0~25.0~50.0~75.0~100.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "aqiColortable",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -10.0,
              "rgba(0, 228, 0, 1.0)",
              25.0,
              "rgba(255, 255, 0, 1.0)",
              50.0,
              "rgba(255, 126, 0, 1.0)",
              75.0,
              "rgba(255, 0, 0, 1.0)",
              100.0,
              "rgba(143, 63, 151, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - Air Quality Index (AQI) Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSAirQualityDailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodayahead', 'threedayahead', 'fourdayahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_airquality_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_airquality_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/aqiColortable~706~sfc~daily~mean~contourSteps~-10.0~25.0~50.0~75.0~100.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "aqiColortable",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -10.0,
              "rgba(0, 228, 0, 1.0)",
              25.0,
              "rgba(255, 255, 0, 1.0)",
              50.0,
              "rgba(255, 126, 0, 1.0)",
              75.0,
              "rgba(255, 0, 0, 1.0)",
              100.0,
              "rgba(143, 63, 151, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - Desert Dust Hourly Forecast
 * 12 hourly frames
 ***********************************************************************/
export function generateMeteoblueCAMSDesertDustHourlyLayers(metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, i) => {
    const timeParam = getNextNHoursWithTime(i);
    const date = getPastHours(-i, "short");
    const suffix = i === 0 ? "" : `_${['onehourahead', 'twohourahead', 'threehourahead', 'fourhourahead', 'fivehourahead', 'sixhourahead', 'sevenhourahead', 'eighthourahead', 'ninehourahead', 'tenhourahead', 'elevenhourahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_desertdust_hourly_forecast${suffix}`;
    const layerId = `meteoblue_cams_desertdust_hourly${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/desertDust~702~sfc~hourly~none~contourSteps~30.0~50.0~100.0~150.0~200.0~250.0~300.0~400.0~600.0~800.0~1500.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "desertDust",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              30.0,
              "rgba(178, 163, 70, 1.0)",
              50.0,
              "rgba(217, 192, 0, 1.0)",
              100.0,
              "rgba(212, 161, 43, 1.0)",
              150.0,
              "rgba(208, 141, 55, 1.0)",
              200.0,
              "rgba(231, 136, 53, 1.0)",
              250.0,
              "rgba(255, 83, 90, 1.0)",
              300.0,
              "rgba(168, 0, 90, 1.0)",
              400.0,
              "rgba(153, 9, 74, 1.0)",
              600.0,
              "rgba(121, 0, 56, 1.0)",
              800.0,
              "rgba(90, 3, 40, 1.0)",
              1500.0,
              "rgba(46, 0, 0, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - Desert Dust Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSDesertDustDailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodayahead', 'threedayahead', 'fourdayahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_desertdust_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_desertdust_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/desertDust~702~sfc~daily~mean~contourSteps~30.0~50.0~100.0~150.0~200.0~250.0~300.0~400.0~600.0~800.0~1500.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "desertDust",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              30.0,
              "rgba(178, 163, 70, 1.0)",
              50.0,
              "rgba(217, 192, 0, 1.0)",
              100.0,
              "rgba(212, 161, 43, 1.0)",
              150.0,
              "rgba(208, 141, 55, 1.0)",
              200.0,
              "rgba(231, 136, 53, 1.0)",
              250.0,
              "rgba(255, 83, 90, 1.0)",
              300.0,
              "rgba(168, 0, 90, 1.0)",
              400.0,
              "rgba(153, 9, 74, 1.0)",
              600.0,
              "rgba(121, 0, 56, 1.0)",
              800.0,
              "rgba(90, 3, 40, 1.0)",
              1500.0,
              "rgba(46, 0, 0, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - Aerosol Optical Depth (AOD) Hourly Forecast
 * 12 hourly frames
 ***********************************************************************/
export function generateMeteoblueCAMSAODHourlyLayers(metbluT) {
  const out = [];

  Array.from({ length: 12 }, (_, i) => {
    const timeParam = getNextNHoursWithTime(i);
    const date = getPastHours(-i, "short");
    const suffix = i === 0 ? "" : `_${['onehourahead', 'twohourahead', 'threehourahead', 'fourhourahead', 'fivehourahead', 'sixhourahead', 'sevenhourahead', 'eighthourahead', 'ninehourahead', 'tenhourahead', 'elevenhourahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_aod_hourly_forecast${suffix}`;
    const layerId = `meteoblue_cams_aod_hourly${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSGLOBAL/${timeParam}/aod~703~atmos col~hourly~none~contourSteps~-10.0~0.05~0.1~0.15~0.2~0.25~0.3~0.35~0.4~0.45~0.5~0.6~0.7~0.8~0.9~1.0~1.5~2.0~3.0~5.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "aod",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -10.0,
              "rgba(90, 90, 90, 1.0)",
              0.05,
              "rgba(93, 87, 115, 1.0)",
              0.1,
              "rgba(95, 87, 131, 1.0)",
              0.15,
              "rgba(72, 101, 143, 1.0)",
              0.2,
              "rgba(5, 124, 141, 1.0)",
              0.25,
              "rgba(0, 143, 128, 1.0)",
              0.3,
              "rgba(0, 151, 111, 1.0)",
              0.35,
              "rgba(74, 158, 90, 1.0)",
              0.4,
              "rgba(112, 161, 72, 1.0)",
              0.45,
              "rgba(150, 160, 71, 1.0)",
              0.5,
              "rgba(165, 158, 77, 1.0)",
              0.6,
              "rgba(191, 155, 92, 1.0)",
              0.7,
              "rgba(217, 153, 113, 1.0)",
              0.8,
              "rgba(238, 151, 145, 1.0)",
              0.9,
              "rgba(255, 150, 175, 1.0)",
              1.0,
              "rgba(255, 155, 195, 1.0)",
              1.5,
              "rgba(240, 186, 207, 1.0)",
              2.0,
              "rgba(233, 198, 212, 1.0)",
              3.0,
              "rgba(226, 211, 217, 1.0)",
              5.0,
              "rgba(220, 220, 220, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - Aerosol Optical Depth (AOD) Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSAODDailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodayahead', 'threedayahead', 'fourdayahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_aod_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_aod_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSGLOBAL/${timeParam}/aod~703~atmos col~daily~mean~contourSteps~-10.0~0.05~0.1~0.15~0.2~0.25~0.3~0.35~0.4~0.45~0.5~0.6~0.7~0.8~0.9~1.0~1.5~2.0~3.0~5.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "aod",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -10.0,
              "rgba(90, 90, 90, 1.0)",
              0.05,
              "rgba(93, 87, 115, 1.0)",
              0.1,
              "rgba(95, 87, 131, 1.0)",
              0.15,
              "rgba(72, 101, 143, 1.0)",
              0.2,
              "rgba(5, 124, 141, 1.0)",
              0.25,
              "rgba(0, 143, 128, 1.0)",
              0.3,
              "rgba(0, 151, 111, 1.0)",
              0.35,
              "rgba(74, 158, 90, 1.0)",
              0.4,
              "rgba(112, 161, 72, 1.0)",
              0.45,
              "rgba(150, 160, 71, 1.0)",
              0.5,
              "rgba(165, 158, 77, 1.0)",
              0.6,
              "rgba(191, 155, 92, 1.0)",
              0.7,
              "rgba(217, 153, 113, 1.0)",
              0.8,
              "rgba(238, 151, 145, 1.0)",
              0.9,
              "rgba(255, 150, 175, 1.0)",
              1.0,
              "rgba(255, 155, 195, 1.0)",
              1.5,
              "rgba(240, 186, 207, 1.0)",
              2.0,
              "rgba(233, 198, 212, 1.0)",
              3.0,
              "rgba(226, 211, 217, 1.0)",
              5.0,
              "rgba(220, 220, 220, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - NO2 Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSNO2DailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodaysahead', 'threedaysahead', 'fourdaysahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_no2_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_no2_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/no2~705~sfc~daily~mean~contourSteps~-0.1~1.0~2.0~3.0~4.0~5.0~7.0~10.0~15.0~20.0~25.0~30.0~40.0~60.0~100.0~150.0~200.0~250.0~300.0~350.0~400.0~500.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "no2",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -0.1,
              "rgba(62, 142, 181, 1.0)",
              1.0,
              "rgba(125, 182, 209, 1.0)",
              2.0,
              "rgba(170, 183, 189, 1.0)",
              3.0,
              "rgba(194, 195, 125, 1.0)",
              4.0,
              "rgba(199, 181, 113, 1.0)",
              5.0,
              "rgba(204, 167, 100, 1.0)",
              7.0,
              "rgba(208, 153, 88, 1.0)",
              10.0,
              "rgba(213, 139, 75, 1.0)",
              15.0,
              "rgba(218, 125, 63, 1.0)",
              20.0,
              "rgba(223, 111, 50, 1.0)",
              25.0,
              "rgba(227, 97, 38, 1.0)",
              30.0,
              "rgba(232, 83, 25, 1.0)",
              40.0,
              "rgba(189, 52, 19, 1.0)",
              60.0,
              "rgba(137, 32, 10, 1.0)",
              100.0,
              "rgba(75, 12, 0, 1.0)",
              150.0,
              "rgba(68, 40, 28, 1.0)",
              200.0,
              "rgba(61, 57, 57, 1.0)",
              250.0,
              "rgba(92, 72, 87, 1.0)",
              300.0,
              "rgba(123, 87, 118, 1.0)",
              350.0,
              "rgba(138, 94, 133, 1.0)",
              400.0,
              "rgba(153, 101, 148, 1.0)",
              500.0,
              "rgba(184, 116, 178, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - CO Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSCODailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodaysahead', 'threedaysahead', 'fourdaysahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_co_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_co_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/COColorTable~711~sfc~daily~mean~contourSteps~0.0~35.0~70.0~90.0~110.0~130.0~150.0~170.0~200.0~230.0~260.0~300.0~350.0~400.0~450.0~600.0~800.0~1000.0~1200.0~1400.0~1800.0~2200.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "COColorTable",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              0.0,
              "rgba(62, 142, 181, 1.0)",
              35.0,
              "rgba(125, 182, 209, 1.0)",
              70.0,
              "rgba(170, 183, 189, 1.0)",
              90.0,
              "rgba(194, 195, 125, 1.0)",
              110.0,
              "rgba(199, 181, 113, 1.0)",
              130.0,
              "rgba(204, 167, 100, 1.0)",
              150.0,
              "rgba(208, 153, 88, 1.0)",
              170.0,
              "rgba(213, 139, 75, 1.0)",
              200.0,
              "rgba(218, 125, 63, 1.0)",
              230.0,
              "rgba(223, 111, 50, 1.0)",
              260.0,
              "rgba(227, 97, 38, 1.0)",
              300.0,
              "rgba(232, 83, 25, 1.0)",
              350.0,
              "rgba(189, 52, 19, 1.0)",
              400.0,
              "rgba(137, 32, 10, 1.0)",
              450.0,
              "rgba(75, 12, 0, 1.0)",
              600.0,
              "rgba(68, 40, 28, 1.0)",
              800.0,
              "rgba(61, 57, 57, 1.0)",
              1000.0,
              "rgba(92, 72, 87, 1.0)",
              1200.0,
              "rgba(123, 87, 118, 1.0)",
              1400.0,
              "rgba(138, 94, 133, 1.0)",
              1800.0,
              "rgba(153, 101, 148, 1.0)",
              2200.0,
              "rgba(184, 116, 178, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Meteoblue CAMS - SO2 Daily Forecast
 * 5 daily frames
 ***********************************************************************/
export function generateMeteoblueCAMSSO2DailyLayers(metbluT) {
  const out = [];

  Array.from({ length: 5 }, (_, i) => {
    const timeParam = getNextDaysMidnight(i);
    const date = getNextNDays(i, "short");
    const suffix = i === 0 ? "" : `_${['onedayahead', 'twodaysahead', 'threedaysahead', 'fourdaysahead'][i - 1]}`;
    const sourceId = `meteoblue_cams_so2_daily_forecast${suffix}`;
    const layerId = `meteoblue_cams_so2_daily${suffix}`;

    out.push({
      source: {
        id: sourceId,
        type: "vector",
        tiles: [
          `https://maps-api.meteoblue.com/v1/map/vector/CAMSAUTO/${timeParam}/so2~704~sfc~daily~mean~contourSteps~-0.1~1.0~2.0~3.0~4.0~5.0~7.0~10.0~15.0~20.0~25.0~30.0~40.0~60.0~100.0~150.0~200.0~250.0~300.0~350.0~400.0~500.0/{z}/{x}/{y}?apikey=${metbluT}`,
        ],
      },
      layers: [
        {
          id: layerId,
          type: "fill",
          source: sourceId,
          "source-layer": "so2",
          paint: {
            "fill-antialias": false,
            "fill-opacity": i === 0 ? 1 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "minValue"],
              -0.1,
              "rgba(62, 142, 181, 1.0)",
              1.0,
              "rgba(125, 182, 209, 1.0)",
              2.0,
              "rgba(170, 183, 189, 1.0)",
              3.0,
              "rgba(194, 195, 125, 1.0)",
              4.0,
              "rgba(199, 181, 113, 1.0)",
              5.0,
              "rgba(204, 167, 100, 1.0)",
              7.0,
              "rgba(208, 153, 88, 1.0)",
              10.0,
              "rgba(213, 139, 75, 1.0)",
              15.0,
              "rgba(218, 125, 63, 1.0)",
              20.0,
              "rgba(223, 111, 50, 1.0)",
              25.0,
              "rgba(227, 97, 38, 1.0)",
              30.0,
              "rgba(232, 83, 25, 1.0)",
              40.0,
              "rgba(189, 52, 19, 1.0)",
              60.0,
              "rgba(137, 32, 10, 1.0)",
              100.0,
              "rgba(75, 12, 0, 1.0)",
              150.0,
              "rgba(68, 40, 28, 1.0)",
              200.0,
              "rgba(61, 57, 57, 1.0)",
              250.0,
              "rgba(92, 72, 87, 1.0)",
              300.0,
              "rgba(123, 87, 118, 1.0)",
              350.0,
              "rgba(138, 94, 133, 1.0)",
              400.0,
              "rgba(153, 101, 148, 1.0)",
              500.0,
              "rgba(184, 116, 178, 1.0)",
            ],
          },
          layout: { visibility: "visible" },
        },
      ],
      date,
    });
  });

  return out;
}
/***********************************************************************
 * Imerger Weather Layers
 ***********************************************************************/
/************************************************************
 * NASA GPM IMERG — Precipitation Rate (raster) | Functional A
 * Window: last 13 days to today (14 frames; 0 = 13 days ago … 13 = today)
 * returns: Array<{ source, layers, date }>
 ************************************************************/
export function generateMBX_IMERGPrecipRateLayers() {
  const out = [];

  Array.from({ length: 14 }, (_, dayOffset) => {
    // Map 0..13 -> -13..0 where 0 == today
    const actualDayOffset = dayOffset - 13;
    const isToday = actualDayOffset === 0;
    const date = getNextNDays(actualDayOffset, "short");

    const suffix =
      actualDayOffset === 0 ? "today" : `${Math.abs(actualDayOffset)}daysago`;
    const sourceId = `mbx_imerg_precip_rate_${suffix}`;

    const tileUrl =
      `https://gitc.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi` +
      `?service=WMS&version=1.3.0&request=GetMap` +
      `&layers=IMERG_Precipitation_Rate&styles=` +
      `&format=image/png&transparent=true` +
      `&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256` +
      `&time=${getNextNDays(actualDayOffset)}`;

    out.push({
      source: {
        id: sourceId,
        type: "raster",
        tiles: [tileUrl],
      },
      layers: [
        {
          id: sourceId,
          type: "raster",
          source: sourceId,
          // keep "visible" and fade with opacity like your original
          layout: { visibility: "visible" },
          paint: {
            "raster-opacity": isToday ? 1.0 : 0.0,
            "raster-opacity-transition": { duration: 500 },
          },
        },
      ],
      date,
    });
  });

  return out;
}

// ============================================================================
// RainViewer — radar precipitation + satellite infrared
// ----------------------------------------------------------------------------
// Both data products are exposed as async frame-builders that return the
// standard temporal-layer shape ([{ source, layers, date }, ...]) so the
// regular #temp-slider1 controller can drive them just like DWD / IMERG /
// ECMWF / etc. The descriptor JSON (`weather-maps.json`) rotates every ~10
// min upstream so a short in-module cache keeps a re-toggle cheap without
// going stale.
// ============================================================================

const RAINVIEWER_DESCRIPTOR_URL =
  "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const RAINVIEWER_FETCH_TIMEOUT_MS = 8000;

// Hard caps tuned for the RainViewer free tier:
//   * Tile fetches scale ~linearly with frame count because every frame is
//     its own raster source. The previous engine capped at 6 to stay under
//     the per-IP rate limit (~20 req/sec); newer descriptors return up to
//     13 past frames which trips 429s instantly. Re-imposing the same cap.
//   * The free tile endpoint stops serving above z≈8; passing maxzoom into
//     both the source AND each layer tells Mapbox to overzoom z=8 tiles
//     instead of requesting ones that would 404 / 429.
const RAINVIEWER_MAX_FRAMES = 6;
const RAINVIEWER_MAXZOOM = 8;

// Pick `n` indices evenly across [0..arr.length-1], always including the
// first and last entry so the slider's start / end labels match the
// requested range exactly.
function evenSampleArray(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length <= n) return arr.slice();
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (n - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(arr[idx]);
  }
  return out;
}

let _rvDescriptorCache = null; // { ts, data }
let _rvInflight = null;        // Promise<data>

async function fetchRainViewerDescriptor() {
  const now = Date.now();
  if (_rvDescriptorCache && now - _rvDescriptorCache.ts < RAINVIEWER_CACHE_TTL_MS) {
    return _rvDescriptorCache.data;
  }
  if (_rvInflight) return _rvInflight;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAINVIEWER_FETCH_TIMEOUT_MS);
  _rvInflight = fetch(RAINVIEWER_DESCRIPTOR_URL, { signal: ctrl.signal })
    .then((r) => {
      if (!r.ok) throw new Error(`RainViewer HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      _rvDescriptorCache = { ts: Date.now(), data };
      _rvInflight = null;
      return data;
    })
    .catch((err) => {
      _rvInflight = null;
      throw err;
    })
    .finally(() => clearTimeout(timer));
  return _rvInflight;
}

function rvFormatPKTLabel(unixSeconds) {
  const pktTime = new Date(unixSeconds * 1000 + 5 * 60 * 60 * 1000);
  const day = String(pktTime.getUTCDate()).padStart(2, "0");
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const mon = MONTHS[pktTime.getUTCMonth()];
  const h = pktTime.getUTCHours();
  const m = pktTime.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${mon} ${day} - ${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

function rvCollectFrames(node, key) {
  // Support both newer ({ past, nowcast }) and older ({ infrared, past, frames })
  // descriptor shapes. Returns an array of {time, path} sorted by time.
  if (!node || typeof node !== "object") return [];
  const pools = [];
  if (key === "radar") {
    if (Array.isArray(node.past)) pools.push(node.past);
    if (Array.isArray(node.nowcast)) pools.push(node.nowcast);
  } else if (key === "satellite") {
    if (Array.isArray(node.infrared)) pools.push(node.infrared);
    if (Array.isArray(node.past) && pools.length === 0) pools.push(node.past);
    if (Array.isArray(node.frames) && pools.length === 0) pools.push(node.frames);
  }
  if (pools.length === 0) {
    // Last-resort: any array of {time, path} on the node
    for (const v of Object.values(node)) {
      if (
        Array.isArray(v) &&
        v.length &&
        v.some((it) => it && typeof it === "object" && it.time && it.path)
      ) {
        pools.push(v);
        break;
      }
    }
  }
  const flat = pools.flat().filter(
    (f) => f && typeof f.time === "number" && typeof f.path === "string"
  );
  flat.sort((a, b) => a.time - b.time);
  return flat;
}

function rvBuildEntry(host, frame, kind) {
  // kind: "radar" -> color scheme 2, options 1_1 (smooth + snow)
  //       "satellite" -> color scheme 0, options 0_0 (default IR ramp)
  const tail = kind === "radar" ? "2/1_1" : "0/0_0";
  const tile = `${host}${frame.path}/256/{z}/{x}/{y}/${tail}.png`;
  const id = `rv_${kind}_${frame.time}`;
  return {
    source: {
      id,
      type: "raster",
      tileSize: 256,
      tiles: [tile],
      // Cap source overzoom so Mapbox uses z=8 tiles for higher zooms instead
      // of requesting tiles the free tier won't serve.
      maxzoom: RAINVIEWER_MAXZOOM,
    },
    layers: [
      {
        id,
        type: "raster",
        source: id,
        layout: { visibility: "visible" },
        paint: {
          "raster-opacity": 0,
          "raster-fade-duration": 200,
        },
        maxzoom: RAINVIEWER_MAXZOOM,
      },
    ],
    date: rvFormatPKTLabel(frame.time),
  };
}

export async function generateRainViewerRadarLayers() {
  const data = await fetchRainViewerDescriptor();
  const host = data?.host;
  if (!host) throw new Error("RainViewer descriptor missing host");
  const allFrames = rvCollectFrames(data.radar, "radar");
  // Empty (rare for radar) → return [] so the slider stays closed silently
  // instead of surfacing a hard error.
  if (!allFrames.length) return [];
  const frames = evenSampleArray(allFrames, RAINVIEWER_MAX_FRAMES);
  return frames.map((f) => rvBuildEntry(host, f, "radar"));
}

export async function generateRainViewerSatelliteIRLayers() {
  const data = await fetchRainViewerDescriptor();
  const host = data?.host;
  if (!host) throw new Error("RainViewer descriptor missing host");
  const allFrames = rvCollectFrames(data.satellite, "satellite");
  // Upstream's `satellite.infrared` array is sometimes briefly empty.
  // Treat as a graceful no-op rather than a thrown error.
  if (!allFrames.length) return [];
  const frames = evenSampleArray(allFrames, RAINVIEWER_MAX_FRAMES);
  return frames.map((f) => rvBuildEntry(host, f, "satellite"));
}


// ===========================================================================
// PMD Predictions (WRFPRS precipitation forecast rasters)
// ---------------------------------------------------------------------------
// The backend endpoint /api/pmd/monitor/predictions/<element_key>/ fetches
// authenticated GeoTIFFs from the vendor PMD Monitor system, warps them to
// EPSG:3857, colorizes via GDAL, and returns one {date, url, coordinates}
// per forecast hour.  Here we map that into the temporal-slider entry shape
// the rest of NCOP uses — one Mapbox `image` source per step, one `raster`
// layer referencing it, only step 0 rendered opaque at load.
//
// Wired into the sidebar as a `() => Promise<Array<entry>>` factory (see
// map-layers.js).  The temporal dispatcher (mapbox-functions.js) treats
// factory + promise the same as static arrays — invokes the factory,
// awaits the resulting promise, hands the resolved frames to
// updateTempSliderAsync which finally calls updateTempSlider.
//
// Session cache: the loader memoises its most-recent successful result
// per elementKey so re-toggling the same layer during one session doesn't
// re-fetch the whole frame list from the backend.  A different elementKey
// is cached independently; the memo is cleared on the first fetch error.
// ===========================================================================
const _PMD_PRED_CACHE = new Map(); // elementKey → Array<entry>

// Slider label thinner — the temporal slider renders one <span> per frame,
// so with 20-30 steps the labels cascade into an unreadable strip.  Solution
// that doesn't touch the shared slider code: emit a formatted date only for
// a small, evenly-spaced subset of indices (first + last + every-Nth), and
// return an empty string for the rest.  Empty spans still get created (so
// step indexing stays 1:1 with frames and click-to-jump keeps working), but
// they render as 0-width elements — visually silent, functionally intact.
// Target ~8 visible labels regardless of frame count.
function _pmdPickLabelIndices(total, target = 8) {
  if (total <= target) return null; // null = show every label
  const step = Math.max(1, Math.ceil(total / target));
  const picks = new Set([0, total - 1]);
  for (let i = 0; i < total; i += step) picks.add(i);
  return picks;
}

function _pmdPredBuildEntry(step, index, itemKey, showLabel) {
  const id = `${itemKey}_${index}`;
  return {
    source: {
      id,
      // Mapbox `image` source (one static PNG pinned to 4 corner coords).
      // Correct primitive for pre-rendered raster steps — `raster` would
      // want a {z}/{x}/{y} tile template which we do not have here.
      type: "image",
      url: step.url,
      coordinates: step.coordinates,
    },
    layers: [
      {
        id,
        type: "raster", // layer type stays `raster` — it renders both
                        // raster-tile AND image sources; not a typo.
        source: id,
        layout: { visibility: "visible" },
        paint: {
          "raster-opacity": index === 0 ? 0.85 : 0,
          "raster-fade-duration": 500,
        },
      },
    ],
    // Empty date on skipped indices => 0-width span => uncluttered strip.
    date: showLabel ? _pmdPredFormatDate(step.date) : "",
  };
}

function _pmdPredFormatDate(iso) {
  // Convert 2026-07-27T03:00:00 → "Jul 27 - 08:00 AM" in PKT (UTC+5),
  // matching the label style used by DWD / IMERG entries so the shared
  // timeline year-labels renderer displays them consistently.
  if (!iso) return "";
  try {
    const utc = new Date(iso);
    if (Number.isNaN(utc.getTime())) return String(iso);
    const pkt = new Date(utc.getTime() + 5 * 60 * 60 * 1000);
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const day = String(pkt.getUTCDate()).padStart(2, "0");
    const mon = MONTHS[pkt.getUTCMonth()];
    let h = pkt.getUTCHours();
    const m = String(pkt.getUTCMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${mon} ${day} - ${String(h).padStart(2, "0")}:${m} ${ampm}`;
  } catch (_) {
    return String(iso);
  }
}

/**
 * Factory: returns a builder function that, when invoked, fetches the
 * per-element frame list from the Django proxy and resolves it into the
 * temporal-slider entry shape.  Assign the returned function (not its
 * result) to `window[itemKey]` — the temporal dispatcher calls it lazily
 * on the user's first click, so no boot-time network cost.
 *
 * @param {"hourtpe"|"sixtpe"|"twelvetpe"|"daytpe"} elementKey
 * @param {string} itemKey  window key + sidebar data-item-key (e.g. "pmd_pred_hourtpe")
 * @returns {() => Promise<Array<entry>>}
 */
export function generatePmdPredictionsLoader(elementKey, itemKey) {
  return async function _loadPmdPredictions() {
    if (_PMD_PRED_CACHE.has(elementKey)) {
      return _PMD_PRED_CACHE.get(elementKey);
    }
    const url = `${window.location.origin}/api/pmd/monitor/predictions/${elementKey}/`;
    let data;
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) {
        console.warn(`[pmd-predictions] ${elementKey} → HTTP ${r.status}`);
        return [];
      }
      data = await r.json();
    } catch (e) {
      console.warn(`[pmd-predictions] ${elementKey} fetch failed:`, e);
      return [];
    }
    const steps = Array.isArray(data?.steps) ? data.steps : [];
    if (!steps.length) {
      console.info(`[pmd-predictions] ${elementKey} returned no frames`);
      return [];
    }
    // Decide which indices should show a real label before we walk the list
    // — computed once per layer load rather than per-entry.
    const showAt = _pmdPickLabelIndices(steps.length, 8);
    const frames = steps.map((s, i) =>
      _pmdPredBuildEntry(s, i, itemKey, showAt === null || showAt.has(i))
    );
    _PMD_PRED_CACHE.set(elementKey, frames);
    return frames;
  };
}
