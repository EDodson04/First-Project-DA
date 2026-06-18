const axios = require('axios');

const MAPS_KEY = () => process.env.GOOGLE_MAPS_API_KEY;
const BASE_URL = 'https://maps.googleapis.com/maps/api';

async function geocodeAddress(address) {
  if (!MAPS_KEY()) return null;
  try {
    const r = await axios.get(`${BASE_URL}/geocode/json`, {
      params: { address, key: MAPS_KEY() },
      timeout: 8000,
    });
    if (r.data.status !== 'OK' || !r.data.results.length) return null;
    const loc = r.data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, formatted: r.data.results[0].formatted_address };
  } catch (err) {
    console.error('Geocode error:', err.message);
    return null;
  }
}

async function getDistanceMatrix(origins, destinations) {
  if (!MAPS_KEY()) return null;
  try {
    const r = await axios.get(`${BASE_URL}/distancematrix/json`, {
      params: {
        origins: origins.join('|'),
        destinations: destinations.join('|'),
        key: MAPS_KEY(),
        units: 'imperial',
      },
      timeout: 10000,
    });
    return r.data;
  } catch (err) {
    console.error('Distance matrix error:', err.message);
    return null;
  }
}

async function optimizeRoute(startAddress, jobs) {
  if (!jobs.length) return jobs;

  // Build coordinate list
  const coords = jobs.map(j =>
    j.lat && j.lng ? `${j.lat},${j.lng}` : `${j.address}, ${j.city || ''}, ${j.state || 'UT'}`
  );

  if (!MAPS_KEY() || jobs.length === 1) {
    return jobs.map((j, i) => ({ ...j, scheduled_order: i + 1, drive_time_from_prev_minutes: 10 }));
  }

  // Use a greedy nearest-neighbor approach with distance matrix
  const allPoints = [startAddress, ...coords];
  const matrix = await getDistanceMatrix(allPoints, allPoints);

  if (!matrix || matrix.status !== 'OK') {
    return jobs.map((j, i) => ({ ...j, scheduled_order: i + 1, drive_time_from_prev_minutes: 15 }));
  }

  const n = jobs.length;
  const visited = new Array(n).fill(false);
  const order = [];
  let current = 0; // start at origin (index 0)

  for (let step = 0; step < n; step++) {
    let best = -1;
    let bestDuration = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const row = matrix.rows[current];
      const el = row && row.elements[j + 1];
      if (el && el.status === 'OK') {
        const dur = el.duration.value;
        if (dur < bestDuration) {
          bestDuration = dur;
          best = j;
        }
      }
    }
    if (best === -1) {
      // fallback: pick first unvisited
      best = visited.indexOf(false);
    }
    visited[best] = true;
    const driveTime = Math.round(bestDuration / 60);
    order.push({ ...jobs[best], scheduled_order: step + 1, drive_time_from_prev_minutes: driveTime });
    current = best + 1;
  }

  return order;
}

async function getDriveTime(fromAddress, toAddress) {
  if (!MAPS_KEY()) return 15;
  const matrix = await getDistanceMatrix([fromAddress], [toAddress]);
  if (!matrix || matrix.status !== 'OK') return 15;
  const el = matrix.rows[0]?.elements[0];
  if (!el || el.status !== 'OK') return 15;
  return Math.round(el.duration.value / 60);
}

// Detect zone (1/2/3) from a geocoded address string
function detectZone(formattedAddress) {
  if (!formattedAddress) return 2;
  const addr = formattedAddress.toLowerCase();

  const zone1Cities = ['hyde park', 'smithfield', 'richmond', 'lewiston', 'newton', 'cornish'];
  const zone3Cities = ['nibley', 'hyrum', 'wellsville', 'mendon', 'paradise'];
  // Providence hillside is zone 3, flat Providence is zone 2

  if (zone1Cities.some(c => addr.includes(c))) return 1;
  if (zone3Cities.some(c => addr.includes(c))) return 3;
  // Providence needs special handling - approximate by zip
  if (addr.includes('providence') && (addr.includes('84332') || addr.includes('hillside'))) return 3;
  return 2; // Default: Central (Logan, North Logan, Providence flat, River Heights, Millville)
}

// Calculate mileage surcharge from base to customer address
async function calculateMileageSurcharge(customerAddress) {
  const startAddress = process.env.ROUTE_START_ADDRESS || '1645 E 2450 N, North Logan, UT 84341';
  const fuelRate = parseFloat(process.env.FUEL_COST_PER_MILE) || 0.25;

  if (!MAPS_KEY() || !customerAddress) {
    return { miles: 0, surcharge: 0 };
  }

  try {
    const matrix = await getDistanceMatrix([startAddress], [customerAddress]);
    if (!matrix || matrix.status !== 'OK') return { miles: 0, surcharge: 0 };
    const el = matrix.rows[0]?.elements[0];
    if (!el || el.status !== 'OK') return { miles: 0, surcharge: 0 };

    const miles = el.distance.value / 1609.34; // meters to miles
    const roundTripMiles = miles * 2;
    const rawSurcharge = roundTripMiles * fuelRate;
    // Round to nearest $5
    const surcharge = Math.round(rawSurcharge / 5) * 5;

    return { miles: Math.round(miles * 10) / 10, surcharge };
  } catch (err) {
    console.error('Mileage calc error:', err.message);
    return { miles: 0, surcharge: 0 };
  }
}

module.exports = { geocodeAddress, getDistanceMatrix, optimizeRoute, getDriveTime, detectZone, calculateMileageSurcharge };
