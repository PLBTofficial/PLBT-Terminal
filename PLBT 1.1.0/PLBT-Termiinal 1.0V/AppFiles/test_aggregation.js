// Unit test for candle aggregation and W1 timeframe bucket calculation

function getBucketTime(candleTime, targetTimeframeMinutes, useUTC = true) {
  const localOffsetMinutes = useUTC ? 0 : -new Date(candleTime * 1000).getTimezoneOffset();
  const offsetSeconds = localOffsetMinutes * 60;
  const adjustedTime = candleTime + offsetSeconds;

  if (targetTimeframeMinutes === 1440) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }
  
  if (targetTimeframeMinutes === 10080) {
    const d = new Date(adjustedTime * 1000);
    const day = d.getUTCDay();
    const diff = (day === 0 ? -1 : day - 1);
    d.setUTCDate(d.getUTCDate() - diff);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }

  if (targetTimeframeMinutes === 43200) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }
  
  if (targetTimeframeMinutes >= 518400) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCMonth(0, 1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }

  const timeframeSeconds = targetTimeframeMinutes * 60;
  const roundedAdjusted = Math.floor(adjustedTime / timeframeSeconds) * timeframeSeconds;
  return roundedAdjusted - offsetSeconds;
}

function rebuildAggregationCache(baseCandles, targetTimeframeMinutes) {
  const bucketMap = new Map();
  const bucketKeys = [];

  for (let i = 0; i < baseCandles.length; i++) {
    const c = baseCandles[i];
    if (!c || c.time === undefined || c.time === null || isNaN(c.time)) continue;
    const bTime = getBucketTime(Number(c.time), targetTimeframeMinutes);
    let arr = bucketMap.get(bTime);
    if (!arr) {
      arr = [];
      bucketMap.set(bTime, arr);
      bucketKeys.push(bTime);
    }
    arr.push(c);
  }

  bucketKeys.sort((a, b) => a - b);

  const fullAggregated = [];
  for (let i = 0; i < bucketKeys.length; i++) {
    const bTime = bucketKeys[i];
    const candlesInBucket = bucketMap.get(bTime);
    if (!candlesInBucket || candlesInBucket.length === 0) continue;

    candlesInBucket.sort((a, b) => Number(a.time) - Number(b.time));

    const first = candlesInBucket[0];
    const last = candlesInBucket[candlesInBucket.length - 1];

    let high = -Infinity;
    let low = Infinity;
    let volume = 0;

    for (let j = 0; j < candlesInBucket.length; j++) {
      const cb = candlesInBucket[j];
      const h = Number(cb.high);
      const l = Number(cb.low);
      if (!isNaN(h) && h > high) high = h;
      if (!isNaN(l) && l < low) low = l;
      if (cb.volume !== undefined && cb.volume !== null && !isNaN(cb.volume)) {
        volume += cb.volume;
      }
    }

    if (high === -Infinity) high = Math.max(first.open, last.close);
    if (low === Infinity) low = Math.min(first.open, last.close);

    fullAggregated.push({
      time: bTime,
      open: parseFloat(Number(first.open).toFixed(5)),
      high: parseFloat(high.toFixed(5)),
      low: parseFloat(low.toFixed(5)),
      close: parseFloat(Number(last.close).toFixed(5)),
      volume: volume
    });
  }

  return fullAggregated;
}

// Test case setup
// Week 1: Monday June 1, 2026 to Friday June 5, 2026
const t_mon1 = Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000);
const t_fri1 = Math.floor(new Date("2026-06-05T20:00:00Z").getTime() / 1000);

// Week 2: Monday June 8, 2026 to Friday June 12, 2026
const t_mon2 = Math.floor(new Date("2026-06-08T00:00:00Z").getTime() / 1000);
const t_fri2 = Math.floor(new Date("2026-06-12T20:00:00Z").getTime() / 1000);

// Week 3: Sunday June 14, 2026 22:00:00Z (Sunday Forex Open) to Friday June 19, 2026
const t_sun3 = Math.floor(new Date("2026-06-14T22:00:00Z").getTime() / 1000);
const t_mon3 = Math.floor(new Date("2026-06-15T00:00:00Z").getTime() / 1000);
const t_fri3 = Math.floor(new Date("2026-06-19T20:00:00Z").getTime() / 1000);

const sampleM15Candles = [
  // Week 1
  { time: t_mon1, open: 1.0500, high: 1.0550, low: 1.0480, close: 1.0520 },
  { time: t_mon1 + 3600, open: 1.0520, high: 1.0800, low: 1.0400, close: 1.0650 },
  { time: t_fri1, open: 1.0650, high: 1.0720, low: 1.0610, close: 1.0700 },

  // Week 2
  { time: t_mon2, open: 1.0700, high: 1.0750, low: 1.0680, close: 1.0730 },
  { time: t_mon2 + 3600, open: 1.0730, high: 1.1000, low: 1.0600, close: 1.0880 },
  { time: t_fri2, open: 1.0880, high: 1.0920, low: 1.0850, close: 1.0900 },

  // Week 3 (including Sunday 22:00 Forex open)
  { time: t_sun3, open: 1.0900, high: 1.0950, low: 1.0880, close: 1.0920 },
  { time: t_mon3, open: 1.0920, high: 1.1200, low: 1.0850, close: 1.1050 },
  { time: t_fri3, open: 1.1050, high: 1.1150, low: 1.1000, close: 1.1100 },
];

console.log("Running W1 aggregation test...");
const aggregatedW1 = rebuildAggregationCache(sampleM15Candles, 10080);
console.log("Aggregated W1 Candles:", JSON.stringify(aggregatedW1, null, 2));

// Validations
if (aggregatedW1.length !== 3) {
  console.error(`FAIL: Expected 3 candles, got ${aggregatedW1.length}`);
  process.exit(1);
}

// Check Week 1
const w1 = aggregatedW1[0];
if (w1.time !== t_mon1 || w1.open !== 1.0500 || w1.high !== 1.0800 || w1.low !== 1.0400 || w1.close !== 1.0700) {
  console.error("FAIL: Week 1 values incorrect", w1);
  process.exit(1);
}

// Check Week 2
const w2 = aggregatedW1[1];
if (w2.time !== t_mon2 || w2.open !== 1.0700 || w2.high !== 1.1000 || w2.low !== 1.0600 || w2.close !== 1.0900) {
  console.error("FAIL: Week 2 values incorrect", w2);
  process.exit(1);
}

// Check Week 3 (Must align to Monday June 15)
const w3 = aggregatedW1[2];
if (w3.time !== t_mon3 || w3.open !== 1.0900 || w3.high !== 1.1200 || w3.low !== 1.0850 || w3.close !== 1.1100) {
  console.error("FAIL: Week 3 values incorrect", w3);
  process.exit(1);
}

console.log("SUCCESS: All W1 aggregation assertions passed perfectly!");
