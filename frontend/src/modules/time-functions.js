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
 LAYER definations and additions 
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
// LAYER definitions and additions
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
//--------------- LAYER definitions and additions - Air Quality Layers Start-------------------------------------------

export function generatePM25Layers() {
  const pm25 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `pm25_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_pm2p5&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    pm25.push(entry);
  });

  return pm25;
}

export function generatePM10Layers() {
  const pm10 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `pm10_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_pm10&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    pm10.push(entry);
  });

  return pm10;
}

export function generateNO2Layers() {
  const no2 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `no2_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_no2_850hpa&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    no2.push(entry);
  });

  return no2;
}

export function generateSO2Layers() {
  const so2 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `so2_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_so2_850hpa&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    so2.push(entry);
  });

  return so2;
}

export function generateO3Layers() {
  const o3 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `o3_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_o3_totalcolumn&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    o3.push(entry);
  });

  return o3;
}

export function generateCOLayers() {
  const co = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `co_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_co_totalcolumn&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    co.push(entry);
  });

  return co;
}

export function generateDustLayers() {
  const dust = [];

  Array.from({ length: 5 }, (_, index) => {
    const id = `dust_${index + 1}`;
    const time = getNextNDays(index);

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&LAYERS=composition_ch4_300hpa&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=true&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&TIME=${time}T00:00:00Z`,
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
      date: getNextNDays(index, "short"),
    };

    dust.push(entry);
  });

  return dust;
}

export function generateCH4300Layers() {
  const ch4300 = [];

  Array.from({ length: 6 }, (_, index) => {
    const id = `ch4300_${index + 1}`;
    const time = getNextNDays(index, "short");

    const entry = {
      source: {
        id,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://eccharts.ecmwf.int/wms/?token=public&SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&FORMAT=image/png&TRANSPARENT=false&WIDTH=256&HEIGHT=256&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&LAYERS=composition_ch4_300hpa&TIME=${time}-2025T00:00:00Z`,
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
      date: time,
    };

    ch4300.push(entry);
  });

  return ch4300;
}


// GDPS Layers
export function generateGDPSHumLayers() {
  const gdpsHumLayers = [];

  // Iterate 11 times (index 0 to 10) to cover "today" and "onedayahead" through "tendayahead"
  Array.from({ length: 11 }, (_, index) => {
    // Determine the ID suffix based on the index
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
      "tendayahead",
    ];

    const suffix = idSuffixes[index];
    const date = getNextNDays(index, "short");
    // Assuming getNextNDaysWithTime(index, "00", "00", "00") provides the time parameter
    const timeParam = getNextNDaysWithTime(index, "00", "00", "00"); 

    // --- Relative Humidity Layer Entry ---
    const idRelHum = `gdps_rel_hum_${suffix}`;
    const relHumEntry = {
      date, // The date property is moved up one level
      source: {
        id: idRelHum,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS.ETA_HR`,
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
            // Changed "raster-fade-duration" to "raster-opacity-transition" to match the new syntax
            "raster-opacity-transition": { duration: 1000 }, 
          },
        },
      ],
    };

    // --- Specific Humidity Layer Entry ---
    const idSpecHum = `gdps_spec_hum_${suffix}`;
    const specHumEntry = {
      date, // The date property is moved up one level
      source: {
        id: idSpecHum,
        type: "raster",
        tileSize: 256,
        tiles: [
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS.ETA_HU_2m`,
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
            // Changed "raster-fade-duration" to "raster-opacity-transition" to match the new syntax
            "raster-opacity-transition": { duration: 1000 },
          },
        },
      ],
    };

    // Push both entries to the final array
    gdpsHumLayers.push(relHumEntry, specHumEntry);
  });

  return gdpsHumLayers;
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
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS.ETA_PR`,
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
          `https://geo.weather.gc.ca/geomet?bbox={bbox-epsg-3857}&format=image/png&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857&transparent=true&width=256&height=256&time=${timeParam}&layers=GDPS.DIAG_NW_PT1H`,
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
 * 3) Meteoblue “Hourly Temperature” (vector, 8 entries)
 *    (Keeps your hourly URL; takes 'level' explicitly)
 ***********************************************************************/
export function generateMBX_MeteoblueHourlyTemperatureLayers(model, level, metbluT) {
  const out = [];

  Array.from({ length: 8 }, (_, index) => {
    const date = getNextNDays(index, "short");
    const time = getNextNDaysWithTime(index);
    const suffix = MBX_DAY_SUFFIXES[index];
    const sourceId = `mbx_temp_hourly_${suffix}`;

    const url =
      `https://maps-api.meteoblue.com/v1/map/vector/${model}/${time}` +
      `/temperatureLayer~11~${level}~hourly~none~contourSteps~-100.0~-8.0~-6.0~-4.0~-2.0~0.0~2.0~4.0~6.0~8.0~10.0~12.0~14.0~16.0~18.0~20.0~46.0/{z}/{x}/{y}` +
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
          "source-layer": "temperatureLayer",
          layout: { visibility: "none" },
          paint: {
            "fill-antialias": false,
            "fill-opacity": index === 0 ? 0.5 : 0,
            "fill-opacity-transition": { duration: 500 },
            "fill-color": [
              "interpolate", ["linear"], ["get", "minValue"],
              -100, "rgba(52,140,237,1.0)",
              -8, "rgba(68,177,246,1.0)",
              -6, "rgba(81,203,250,1.0)",
              -4, "rgba(128,224,247,1.0)",
              -2, "rgba(160,234,247,1.0)",
              0, "rgba(0,239,124,1.0)",
              2, "rgba(0,228,82,1.0)",
              4, "rgba(0,200,72,1.0)",
              6, "rgba(16,184,122,1.0)",
              8, "rgba(41,123,93,1.0)",
              10, "rgba(0,114,41,1.0)",
              12, "rgba(60,161,44,1.0)",
              14, "rgba(121,208,48,1.0)",
              16, "rgba(181,255,51,1.0)",
              18, "rgba(216,247,161,1.0)",
              20, "rgba(255,246,0,1.0)",
              46, "rgba(243,22,194,1.0)"
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