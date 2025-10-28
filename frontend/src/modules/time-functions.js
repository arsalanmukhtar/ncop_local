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
// LAYER definations and additions 
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