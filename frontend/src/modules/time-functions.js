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
