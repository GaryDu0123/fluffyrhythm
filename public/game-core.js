export const BPM = 135;
export const BEAT = 60 / BPM;
// 曲頭から切り出した音源の8分音符グリッド先頭。
// 全尺のオンセット解析で、後半までドリフトしない位相に合わせている。
export const FIRST_BEAT = 0.0038;
export const CLIP_DURATION = 85;
export const TRAVEL_TIME = 1.65;

const patterns = [
  [[0, 0], [2, 1], [4, 2], [6, 3]],
  [[0, 0], [1, 1], [3, 2], [4, 3], [6, 0], [7, 1]],
  [[0, 3], [2, 2], [3, 1], [4, 0], [6, 1], [7, 3]],
  [[0, [0, 3]], [2, 1], [3, 2], [4, [0, 3]], [6, 2]],
  [[0, 0], [1, 2], [2, 1], [4, 3], [5, 1], [6, 0]],
  [[0, 3], [1, 2], [2, 0], [3, 1], [4, 2], [6, [0, 3]]],
  [[0, 1], [2, 2], [4, 1], [5, 3], [6, 3], [7, 0]],
  [[0, [1, 2]], [2, 0], [3, 1], [4, 3], [5, 2], [6, [0, 3]]]
];

export function createChart() {
  const notes = [];
  let id = 0;
  const firstMeasureBeat = 3;
  for (let measure = 0; ; measure += 1) {
    const measureStart = FIRST_BEAT + (firstMeasureBeat + measure * 4) * BEAT;
    if (measureStart > CLIP_DURATION - 1.5) break;
    const pattern = patterns[measure % patterns.length];
    const laneRotation = Math.floor(measure / patterns.length) % 4;
    for (const [sub, laneValue] of pattern) {
      const time = FIRST_BEAT + (firstMeasureBeat + measure * 4 + sub / 2) * BEAT;
      if (time > CLIP_DURATION - 1.5) continue;
      const lanes = Array.isArray(laneValue) ? laneValue : [laneValue];
      for (const lane of lanes) notes.push({ id: id++, time, lane: (lane + laneRotation) % 4 });
    }
  }
  return notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
}

export function judgeDelta(deltaSeconds) {
  const delta = Math.abs(deltaSeconds);
  if (delta <= 0.075) return { label: "PERFECT", value: 1000 };
  if (delta <= 0.15) return { label: "GREAT", value: 700 };
  if (delta <= 0.24) return { label: "GOOD", value: 400 };
  return null;
}

export function normalizeScore(rawScore, noteCount) {
  if (!noteCount) return 0;
  return Math.round((rawScore / (noteCount * 1000)) * 1_000_000);
}

export function rankFor(score) {
  if (score >= 950000) return { rank: "S", title: "なるようになった！" };
  if (score >= 850000) return { rank: "A", title: "かなりいい感じ！" };
  if (score >= 700000) return { rank: "B", title: "流れに乗れてる！" };
  if (score >= 500000) return { rank: "C", title: "あと少しで波に乗れそう" };
  return { rank: "D", title: "もう一度、なるようになる" };
}
