// 강남차 여성병원 건강강좌 만족도 조사 시스템

// ============================================================================
// PWA: 매니페스트 + 아이콘 (아이콘 PNG는 dist/ 정적 파일로 직접 서빙)
// ============================================================================

const APP_NAME = "강남차 건강강좌 설문 관리";
const APP_SHORT_NAME = "설문 관리";
const APP_THEME_COLOR = "#7c2a5e";

const MANIFEST = {
  name: APP_NAME,
  short_name: APP_SHORT_NAME,
  description: "강남차 여성병원 건강강좌 만족도 조사 관리자 대시보드",
  start_url: "/admin",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: "#ffffff",
  theme_color: APP_THEME_COLOR,
  lang: "ko-KR",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

function manifestResponse() {
  return new Response(JSON.stringify(MANIFEST), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

const PWA_HEAD_TAGS = `<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
<meta name="theme-color" content="${APP_THEME_COLOR}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${APP_SHORT_NAME}">`;

// ============================================================================
// 유틸리티
// ============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function kstYMD() {
  // KST = UTC+9
  const utc = Date.now();
  const kst = new Date(utc + 9 * 3600 * 1000);
  return {
    year: kst.getUTCFullYear(),
    month: kst.getUTCMonth() + 1,
    day: kst.getUTCDate(),
  };
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getStoredHash(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'admin_password_hash'"
    ).first();
    if (row && row.value) return row.value;
  } catch {}
  if (env.ADMIN_PASSWORD) return await sha256Hex(env.ADMIN_PASSWORD);
  return null;
}

// 마스터 비밀번호 — Cloudflare Pages 환경 변수(MASTER_PASSWORD)로 설정
// 변경된 비밀번호를 잊어버려도 항상 사용 가능한 복구용
async function checkAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "unauthorized" }, 401);
  if (env.MASTER_PASSWORD && token === env.MASTER_PASSWORD) return null;
  const stored = await getStoredHash(env);
  if (!stored) return json({ error: "auth not configured" }, 500);
  const inputHash = await sha256Hex(token);
  if (inputHash !== stored) return json({ error: "unauthorized" }, 401);
  return null;
}

async function apiAdminChangePassword(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const newPwd = (body && body.new) || "";
  if (typeof newPwd !== "string" || newPwd.length < 4) {
    return json({ error: "비밀번호는 4자 이상이어야 합니다" }, 400);
  }
  const newHash = await sha256Hex(newPwd);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)"
  ).bind(newHash).run();
  return json({ ok: true });
}

// ============================================================================
// API: 설문 설정 (문항/보기 텍스트)
// ============================================================================

const DEFAULT_SURVEY_CONFIG = {
  appTitle: "강남차 여성병원 건강강좌 프로그램 만족도 조사",
  brandLine: "강남차 여성병원",
  q1: { title: "수강한 교육명을 체크해주세요" },
  q2: { title: "현재 임신 중이신가요?", options: ["첫째", "둘째", "셋째 이상", "해당없음"] },
  q3: { title: "교육을 어떻게 알고 신청하셨나요?(중복선택 가능)", options: ["병원 직원의 안내", "온라인에서 정보 습득 (홈페이지, 블로그 등)", "지인 추천", "기타"] },
  q4: { title: "교육을 신청한 이유는 무엇입니까?(중복선택 가능)", options: ["임신 및 출산에 도움", "평소 관심 있는 주제", "가족 및 지인 추천", "강남차병원 교육의 신뢰"] },
  q5_9: { titles: ["교육 진행시간은 적절한가요?", "교육 내용을 이해하기 쉽게 설명하였나요?", "궁금증 해소에 도움이 되었나요?", "교육의 만족도 및 타인 추천할 마음은?", "교육 장소와 시설은 어떠했나요?"] },
  q10: { title: "교육을 통해 느낀 소감, 강의 개선 점, 향후 듣고 싶은 교육이 있다면 작성해주세요" },
};

async function getSurveyConfig(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'survey_config'").first();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      // 누락된 필드는 기본값으로 채움 (호환성)
      return { ...DEFAULT_SURVEY_CONFIG, ...parsed };
    }
  } catch {}
  return DEFAULT_SURVEY_CONFIG;
}

async function apiSurveyConfig(env) {
  const cfg = await getSurveyConfig(env);
  return json({ config: cfg });
}

async function apiAdminUpdateSurveyConfig(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const cfg = body && body.config;
  if (!cfg || typeof cfg !== "object") return json({ error: "config required" }, 400);
  // 최소 검증: 필수 키와 옵션 길이
  if (!cfg.q2 || !Array.isArray(cfg.q2.options) || cfg.q2.options.length !== 4) return json({ error: "q2 options must have 4 items" }, 400);
  if (!cfg.q3 || !Array.isArray(cfg.q3.options) || cfg.q3.options.length !== 4) return json({ error: "q3 options must have 4 items" }, 400);
  if (!cfg.q4 || !Array.isArray(cfg.q4.options) || cfg.q4.options.length !== 4) return json({ error: "q4 options must have 4 items" }, 400);
  if (!cfg.q5_9 || !Array.isArray(cfg.q5_9.titles) || cfg.q5_9.titles.length !== 5) return json({ error: "q5_9 titles must have 5 items" }, 400);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('survey_config', ?)"
  ).bind(JSON.stringify(cfg)).run();
  return json({ ok: true });
}

// ============================================================================
// API: 강좌 CRUD (관리자)
// ============================================================================

async function apiAdminListLectures(env) {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.symbol, l.active,
       (SELECT COUNT(*) FROM responses r WHERE r.lecture_id = l.id) AS response_count
     FROM lectures l
     ORDER BY l.id`
  ).all();
  return json({ lectures: results });
}

function nextCircledSymbol(n) {
  // ① = 0x2460 (n=1) ... ⑳ = 0x2473 (n=20)
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x245F + n);
  return "(" + n + ")";
}

async function apiAdminCreateLecture(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const name = (body && body.name || "").toString().trim();
  if (!name) return json({ error: "name required" }, 400);
  const active = body.active === false ? 0 : 1;
  // 다음 ID 자동 부여
  const maxRow = await env.DB.prepare("SELECT MAX(id) AS m FROM lectures").first();
  const nextId = ((maxRow && maxRow.m) || 0) + 1;
  const symbol = (body.symbol || "").toString().trim() || nextCircledSymbol(nextId);
  await env.DB.prepare(
    "INSERT INTO lectures (id, name, symbol, active) VALUES (?, ?, ?, ?)"
  ).bind(nextId, name, symbol, active).run();
  return json({ ok: true, id: nextId, symbol });
}

async function apiAdminUpdateLecture(request, env, id) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const fields = [];
  const params = [];
  if (typeof body.name === "string" && body.name.trim()) {
    fields.push("name = ?"); params.push(body.name.trim());
  }
  if (typeof body.symbol === "string" && body.symbol.trim()) {
    fields.push("symbol = ?"); params.push(body.symbol.trim());
  }
  if (typeof body.active === "boolean" || body.active === 0 || body.active === 1) {
    fields.push("active = ?"); params.push(body.active ? 1 : 0);
  }
  if (!fields.length) return json({ error: "no changes" }, 400);
  params.push(id);
  await env.DB.prepare("UPDATE lectures SET " + fields.join(", ") + " WHERE id = ?").bind(...params).run();
  return json({ ok: true });
}

async function apiAdminDeleteLecture(env, id) {
  // 응답이 있으면 삭제 거부 (active=0 권장)
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE lecture_id = ?").bind(id).first();
  if (cnt && cnt.n > 0) {
    return json({ error: "응답이 있는 강좌는 삭제할 수 없습니다. 비활성화(active=0)를 사용하세요.", responses: cnt.n }, 400);
  }
  await env.DB.prepare("DELETE FROM lectures WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ============================================================================
// API: Lectures
// ============================================================================

async function apiLectures(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, symbol FROM lectures WHERE active = 1 ORDER BY id"
  ).all();
  return json({ lectures: results });
}

// ============================================================================
// API: Submit response
// ============================================================================

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  if (n < lo || n > hi) return null;
  return n | 0;
}

function sanitizeArray(arr, validValues) {
  if (!Array.isArray(arr)) return [];
  const set = new Set(validValues);
  return arr.filter((v) => set.has(v));
}

async function apiPostResponse(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const lectureId = clamp(body.lecture_id, 1, 9);
  if (lectureId == null) return json({ error: "lecture_id required" }, 400);

  // 강좌가 활성화 상태인지 확인
  const lec = await env.DB.prepare(
    "SELECT id FROM lectures WHERE id = ? AND active = 1"
  )
    .bind(lectureId)
    .first();
  if (!lec) return json({ error: "lecture not active" }, 400);

  const q2 = clamp(body.q2_pregnancy, 1, 4);
  const q3 = sanitizeArray(body.q3_source, [1, 2, 3, 4]);
  const q3Etc = (body.q3_etc || "").toString().slice(0, 200) || null;
  const q4 = sanitizeArray(body.q4_reason, [1, 2, 3, 4]);
  const q5 = clamp(body.q5_time, 3, 5);
  const q6 = clamp(body.q6_explain, 3, 5);
  const q7 = clamp(body.q7_curiosity, 3, 5);
  const q8 = clamp(body.q8_satisfaction, 3, 5);
  const q9 = clamp(body.q9_facility, 3, 5);
  const q10 = (body.q10_text || "").toString().trim().slice(0, 2000) || null;

  if ([q2, q5, q6, q7, q8, q9].some((v) => v == null)) {
    return json({ error: "missing required answers" }, 400);
  }
  if (!q10) return json({ error: "10번 문항(자유 서술)은 필수입니다" }, 400);

  const { year, month, day } = kstYMD();

  await env.DB.prepare(
    `INSERT INTO responses
     (lecture_id, year, month, day,
      q2_pregnancy, q3_source, q3_etc, q4_reason,
      q5_time, q6_explain, q7_curiosity, q8_satisfaction, q9_facility, q10_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      lectureId,
      year,
      month,
      day,
      q2,
      JSON.stringify(q3),
      q3Etc,
      JSON.stringify(q4),
      q5,
      q6,
      q7,
      q8,
      q9,
      q10
    )
    .run();

  return json({ ok: true });
}

// ============================================================================
// API: Admin stats
// ============================================================================

async function fetchResponses(env, where, params) {
  const sql = `
    SELECT r.*, l.name AS lecture_name, l.symbol AS lecture_symbol
    FROM responses r
    JOIN lectures l ON l.id = r.lecture_id
    ${where}
    ORDER BY r.lecture_id, r.year, r.month, r.day, r.id
  `;
  const stmt = params.length ? env.DB.prepare(sql).bind(...params) : env.DB.prepare(sql);
  const { results } = await stmt.all();
  return results.map((r) => ({
    ...r,
    q3_source: r.q3_source ? JSON.parse(r.q3_source) : [],
    q4_reason: r.q4_reason ? JSON.parse(r.q4_reason) : [],
  }));
}

function aggregateByLectureQuestion(rows, allLectures) {
  // 문항별 점수 분포 (전체) + 강좌별 분포
  const QS = ["q5_time", "q6_explain", "q7_curiosity", "q8_satisfaction", "q9_facility"];
  const Q_LABELS = {
    q5_time: "5. 교육 진행시간은 적절한가요?",
    q6_explain: "6. 교육 내용을 이해하기 쉽게 설명하였나요?",
    q7_curiosity: "7. 궁금증 해소에 도움이 되었나요?",
    q8_satisfaction: "8. 교육의 만족도 및 타인 추천할 마음은?",
    q9_facility: "9. 교육 장소와 시설은 어떠했나요?",
  };

  // 강좌별 응답수
  const lectureCounts = {};
  for (const l of allLectures) lectureCounts[l.id] = 0;
  for (const r of rows) lectureCounts[r.lecture_id] = (lectureCounts[r.lecture_id] || 0) + 1;

  // (lecture_id, question, score) → count
  const matrix = {};
  for (const q of QS) {
    matrix[q] = { label: Q_LABELS[q], byLecture: {}, total: { 5: 0, 4: 0, 3: 0 } };
    for (const l of allLectures) matrix[q].byLecture[l.id] = { 5: 0, 4: 0, 3: 0 };
  }
  for (const r of rows) {
    for (const q of QS) {
      const s = r[q];
      if (s >= 3 && s <= 5) {
        matrix[q].byLecture[r.lecture_id][s]++;
        matrix[q].total[s]++;
      }
    }
  }

  // 문항별 총 점수합 / 인원
  for (const q of QS) {
    const t = matrix[q].total;
    matrix[q].totalScore = t[5] * 5 + t[4] * 4 + t[3] * 3;
    matrix[q].totalCount = t[5] + t[4] + t[3];
  }

  // 전체 만족도
  let totalScore = 0;
  let totalCount = 0;
  for (const q of QS) {
    totalScore += matrix[q].totalScore;
    totalCount += matrix[q].totalCount;
  }
  const maxScore = (totalCount || 0) * 5; // 응답건수 × 5점
  const respondents = rows.length; // 응답자수
  const percent = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

  // Q1~Q4 분포 (서술/통계용)
  const q2Counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const q3Counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const q3EtcList = [];
  const q4Counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) {
    if (r.q2_pregnancy >= 1 && r.q2_pregnancy <= 4) q2Counts[r.q2_pregnancy]++;
    for (const v of r.q3_source) if (q3Counts[v] !== undefined) q3Counts[v]++;
    if (r.q3_etc) q3EtcList.push({ lecture_id: r.lecture_id, day: r.day, text: r.q3_etc });
    for (const v of r.q4_reason) if (q4Counts[v] !== undefined) q4Counts[v]++;
  }

  // 자유 서술 (Q10)
  const comments = rows
    .filter((r) => r.q10_text)
    .map((r) => ({
      lecture_id: r.lecture_id,
      lecture_name: r.lecture_name,
      year: r.year,
      month: r.month,
      day: r.day,
      text: r.q10_text,
    }));

  return {
    respondents,
    lectureCounts,
    matrix,
    summary: {
      totalScore,
      maxScore,
      respondents,
      percent: Math.round(percent * 10) / 10,
    },
    q2Counts,
    q3Counts,
    q3EtcList,
    q4Counts,
    comments,
  };
}

async function getLectures(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, symbol, active FROM lectures ORDER BY id"
  ).all();
  return results;
}

async function apiAdminStats(request, env) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "monthly";
  const year = Number(url.searchParams.get("year") || 0);
  const month = Number(url.searchParams.get("month") || 0);
  const quarter = Number(url.searchParams.get("quarter") || 0);
  const lectureId = Number(url.searchParams.get("lecture_id") || 0);
  const filterLectureId = Number(url.searchParams.get("filter_lecture_id") || 0);

  let where = "";
  let params = [];
  let label = "";

  if (period === "monthly") {
    if (!year || !month) return json({ error: "year, month required" }, 400);
    where = "WHERE r.year = ? AND r.month = ?";
    params = [year, month];
    label = `${year}년 ${month}월`;
  } else if (period === "quarterly") {
    if (!year || !quarter) return json({ error: "year, quarter required" }, 400);
    const startM = (quarter - 1) * 3 + 1;
    const endM = startM + 2;
    where = "WHERE r.year = ? AND r.month BETWEEN ? AND ?";
    params = [year, startM, endM];
    label = `${year}년 ${quarter}분기 (${startM}~${endM}월)`;
  } else if (period === "lecture" || period === "all") {
    // 기간 범위 (from-to) 파싱: "YYYY-MM" 형식
    const fromStr = url.searchParams.get("from") || "";
    const toStr = url.searchParams.get("to") || "";
    const parseYM = (s) => {
      const m = /^(\d{4})-(\d{1,2})$/.exec(s);
      return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
    };
    const fromYM = parseYM(fromStr);
    const toYM = parseYM(toStr);

    const conds = [];
    if (period === "lecture") {
      if (!lectureId) return json({ error: "lecture_id required" }, 400);
      conds.push("r.lecture_id = ?");
      params.push(lectureId);
    }
    if (fromYM) { conds.push("(r.year * 100 + r.month) >= ?"); params.push(fromYM); }
    if (toYM) { conds.push("(r.year * 100 + r.month) <= ?"); params.push(toYM); }
    where = conds.length ? "WHERE " + conds.join(" AND ") : "";

    // 라벨 생성
    const fmtYM = (s) => {
      const m = /^(\d{4})-(\d{1,2})$/.exec(s);
      return m ? `${m[1]}년 ${parseInt(m[2], 10)}월` : "";
    };
    let rangeStr = "";
    if (fromYM && toYM) rangeStr = fromStr === toStr ? fmtYM(fromStr) : `${fmtYM(fromStr)} ~ ${fmtYM(toStr)}`;
    else if (fromYM) rangeStr = `${fmtYM(fromStr)} 이후`;
    else if (toYM) rangeStr = `${fmtYM(toStr)} 이전`;
    else rangeStr = "전체 기간";

    if (period === "lecture") {
      const l = await env.DB.prepare("SELECT name FROM lectures WHERE id = ?").bind(lectureId).first();
      label = (l ? l.name : "강좌") + " — " + rangeStr;
    } else {
      label = rangeStr;
    }
  } else {
    return json({ error: "invalid period" }, 400);
  }

  // 강좌 필터 (월별/분기별에서만 적용)
  if (filterLectureId && (period === "monthly" || period === "quarterly")) {
    where += where ? " AND r.lecture_id = ?" : "WHERE r.lecture_id = ?";
    params.push(filterLectureId);
    const l = await env.DB.prepare("SELECT name, symbol FROM lectures WHERE id = ?").bind(filterLectureId).first();
    if (l) label += ` — ${l.symbol} ${l.name}`;
  }

  const lectures = await getLectures(env);
  const rows = await fetchResponses(env, where, params);
  const agg = aggregateByLectureQuestion(rows, lectures);

  return json({
    period,
    label,
    year,
    month,
    quarter,
    lectureId,
    filterLectureId,
    lectures,
    rows, // 강좌별 시트용 raw data
    ...agg,
  });
}

async function apiAdminAvailableMonths(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT year, month FROM responses ORDER BY year DESC, month DESC"
  ).all();
  return json({ months: results });
}

async function apiAdminLectureSessions(env) {
  // 강좌별로 어떤 (year, month, day) 회차에 응답이 있는지
  const { results } = await env.DB.prepare(
    `SELECT lecture_id, year, month, day, COUNT(*) AS n
     FROM responses
     GROUP BY lecture_id, year, month, day
     ORDER BY lecture_id, year, month, day`
  ).all();
  return json({ sessions: results });
}

// ============================================================================
// HTML: 설문 페이지
// ============================================================================

const SURVEY_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>강남차 여성병원 건강강좌 만족도 조사</title>
${PWA_HEAD_TAGS}
<style>
  :root {
    --p: #7c2a5e;
    --p-dark: #5e2047;
    --p-soft: #fdf3f8;
    --p-num-bg: #f0e5ee;
    --bg: #f5f5f5;
    --card: #fff;
    --bd: #e1e1e1;
    --bd-strong: #c8c8c8;
    --tx: #2b2b2b;
    --mu: #888;
    --req: #ED5351;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", system-ui, sans-serif;
    background: var(--bg);
    color: var(--tx);
    font-size: 15px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 560px; margin: 0 auto; padding: 12px 12px 40px; }

  /* 헤더 */
  .header-card {
    background: var(--card);
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--bd);
    box-shadow: 0 1px 2px rgba(0,0,0,.03);
    margin-bottom: 14px;
  }
  .header-card .top-line { height: 4px; background: var(--p); }
  .header-card .title-area { padding: 22px 18px 18px; }
  .header-card h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--tx);
    line-height: 1.45;
  }
  .header-card .meta {
    margin-top: 10px;
    padding: 8px 12px;
    background: #f3f3f3;
    border-radius: 6px;
    font-size: 13px;
    color: var(--mu);
  }

  /* 답변 필수 안내 */
  .req-notice {
    text-align: right;
    font-size: 13px;
    color: var(--mu);
    margin: 0 4px 6px;
    padding-right: 4px;
  }
  .req-notice b { color: var(--req); margin-right: 2px; font-weight: 700; }

  /* 질문 카드 */
  .q {
    background: var(--card);
    border: 1px solid var(--bd);
    border-radius: 8px;
    padding: 18px 16px;
    margin-bottom: 12px;
  }
  .q .ttl {
    font-weight: 600;
    margin-bottom: 14px;
    font-size: 15px;
    line-height: 1.5;
    color: var(--tx);
  }
  .q .ttl .req { color: var(--req); font-weight: 700; margin-right: 4px; }
  .q .ttl .num { color: var(--p); font-weight: 700; margin-right: 2px; }
  .q .ttl .multi-line {
    display: block;
    color: var(--p);
    font-weight: 500;
    font-size: 14px;
    margin-top: 2px;
  }

  /* 일반 옵션 */
  .opts { display: flex; flex-direction: column; gap: 8px; }
  .opt {
    display: flex; align-items: center; gap: 12px;
    padding: 13px 14px;
    border: 1.5px solid var(--bd);
    border-radius: 8px;
    background: #fcfcfc;
    cursor: pointer;
    transition: background .15s, border-color .15s;
    user-select: none;
  }
  .opt:active { background: #f3f3f3; }
  .opt .circle {
    width: 22px; height: 22px;
    border: 2px solid var(--bd-strong);
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: #fff;
    transition: all .15s;
  }
  .opt.sel {
    border-color: var(--p);
    background: var(--p-soft);
  }
  .opt.sel .circle {
    background: var(--p);
    border-color: var(--p);
  }
  .opt.sel .circle::after {
    content: '✓';
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    line-height: 1;
  }
  .opt .text { flex: 1; color: var(--tx); }

  /* 5점 척도 (Q5-Q9) */
  .scale {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    padding: 6px 4px 2px;
    background: #fafafa;
    border-radius: 8px;
  }
  .scale-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
    padding: 12px 4px 10px;
    border-radius: 8px;
    transition: background .15s;
  }
  .scale-item:active { background: #f0f0f0; }
  .scale-item .num {
    font-size: 14px;
    color: var(--tx);
    margin-bottom: 8px;
  }
  .scale-item .ring {
    width: 28px; height: 28px;
    border: 2px solid var(--bd-strong);
    border-radius: 50%;
    background: #fff;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all .15s;
  }
  .scale-item.sel .ring {
    background: var(--p);
    border-color: var(--p);
  }
  .scale-item.sel .ring::after {
    content: '';
    width: 9px; height: 9px;
    background: #fff;
    border-radius: 50%;
  }
  .scale-item .lbl {
    font-size: 13px;
    color: var(--mu);
    min-height: 16px;
    text-align: center;
  }

  /* 기타 입력 */
  .etc-input { margin-top: 8px; display: none; }
  .etc-input.show { display: block; }
  .etc-input input {
    width: 100%;
    padding: 11px 12px;
    border: 1.5px solid var(--bd);
    border-radius: 6px;
    font-size: 14px;
    background: #fff;
    font-family: inherit;
  }
  .etc-input input:focus { outline: none; border-color: var(--p); }

  /* Q10 */
  textarea {
    width: 100%;
    padding: 11px 12px;
    border: 1.5px solid var(--bd);
    border-radius: 6px;
    font-size: 14px;
    background: #fff;
    font-family: inherit;
    resize: vertical;
    min-height: 56px;
  }
  textarea:focus { outline: none; border-color: var(--p); }

  /* 제출 버튼 */
  .submit-area {
    text-align: center;
    padding: 18px 0 4px;
  }
  button.submit {
    min-width: 140px;
    padding: 13px 36px;
    border: 0;
    background: var(--p);
    color: #fff;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    transition: background .15s;
  }
  button.submit:hover { background: var(--p-dark); }
  button.submit:disabled { background: #bfbfbf; cursor: not-allowed; }

  /* 푸터 */
  footer {
    text-align: center;
    padding: 18px 16px 8px;
    color: var(--mu);
    font-size: 12px;
  }

  /* 완료 화면 */
  .done {
    text-align: center;
    padding: 80px 20px 60px;
    background: var(--card);
    border: 1px solid var(--bd);
    border-radius: 8px;
    margin-top: 20px;
  }
  .done .icon { font-size: 56px; margin-bottom: 16px; }
  .done h2 { margin: 0 0 12px; color: var(--p); font-size: 20px; }
  .done p { color: var(--tx); margin: 6px 0; font-size: 14px; }
  .loading { text-align: center; padding: 60px 20px; color: var(--mu); }
</style>
</head>
<body>
<div id="root"><div class="wrap"><div class="loading">불러오는 중...</div></div></div>
<script>
// 기본 설정 (서버 응답 전 fallback)
const DEFAULT_CFG = {
  appTitle: '강남차 여성병원 건강강좌 프로그램 만족도 조사',
  brandLine: '강남차 여성병원',
  q1: { title: '수강한 교육명을 체크해주세요' },
  q2: { title: '현재 임신 중이신가요?', options: ['첫째','둘째','셋째 이상','해당없음'] },
  q3: { title: '교육을 어떻게 알고 신청하셨나요?(중복선택 가능)', options: ['병원 직원의 안내','온라인에서 정보 습득 (홈페이지, 블로그 등)','지인 추천','기타'] },
  q4: { title: '교육을 신청한 이유는 무엇입니까?(중복선택 가능)', options: ['임신 및 출산에 도움','평소 관심 있는 주제','가족 및 지인 추천','강남차병원 교육의 신뢰'] },
  q5_9: { titles: ['교육 진행시간은 적절한가요?','교육 내용을 이해하기 쉽게 설명하였나요?','궁금증 해소에 도움이 되었나요?','교육의 만족도 및 타인 추천할 마음은?','교육 장소와 시설은 어떠했나요?'] },
  q10: { title: '교육을 통해 느낀 소감, 강의 개선 점, 향후 듣고 싶은 교육이 있다면 작성해주세요' },
};
const SCALE_ITEMS = [
  { v: 3, num: 1, lbl: '보통이다' },
  { v: 4, num: 2, lbl: '' },
  { v: 5, num: 3, lbl: '매우 그렇다' },
];

const SUBMIT_KEY = 'healthSurveySubmitted';

const state = {
  lectures: [],
  cfg: DEFAULT_CFG,
  ans: { lecture_id: null, q2: null, q3: [], q3_etc: '', q4: [], q5: null, q6: null, q7: null, q8: null, q9: null, q10: '' },
  submitting: false,
  done: false,
  alreadySubmitted: null, // {lectureName, at} | null
};

function checkAlreadySubmitted() {
  try {
    const raw = localStorage.getItem(SUBMIT_KEY);
    if (raw) state.alreadySubmitted = JSON.parse(raw);
  } catch {}
}

window.startNewSubmission = () => {
  state.alreadySubmitted = null;
  localStorage.removeItem(SUBMIT_KEY);
  render();
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadInitial() {
  try {
    const [lecRes, cfgRes] = await Promise.all([
      fetch('/api/lectures').then(r => r.json()),
      fetch('/api/survey-config').then(r => r.json()),
    ]);
    state.lectures = lecRes.lectures || [];
    if (cfgRes.config) state.cfg = Object.assign({}, DEFAULT_CFG, cfgRes.config);
    if (state.cfg.appTitle) document.title = state.cfg.appTitle;
  } catch {}
  render();
}

function setSingle(field, value) { state.ans[field] = value; render(); }
function toggleMulti(field, value) {
  const arr = state.ans[field];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(value);
  render();
}

window.onLec = (id) => setSingle('lecture_id', id);
window.onQ2 = (v) => setSingle('q2', v);
window.onQ3 = (v) => toggleMulti('q3', v);
window.onQ3Etc = (val) => { state.ans.q3_etc = val; };
window.onQ4 = (v) => toggleMulti('q4', v);
window.onScore = (q, v) => setSingle(q, v);
window.onQ10 = (val) => { state.ans.q10 = val; };

function optHTML(selected, onclickJS, label) {
  return '<div class="opt'+(selected?' sel':'')+'" onclick="'+onclickJS+'">'+
    '<span class="circle"></span>'+
    '<span class="text">'+escapeHtml(label)+'</span>'+
    '</div>';
}

function scaleHTML(qk, current) {
  return '<div class="scale">' + SCALE_ITEMS.map(s => {
    const sel = current === s.v;
    return '<div class="scale-item'+(sel?' sel':'')+'" onclick="onScore(\\''+qk+'\\','+s.v+')">'+
      '<span class="num">'+s.num+'</span>'+
      '<span class="ring"></span>'+
      '<span class="lbl">'+escapeHtml(s.lbl)+'</span>'+
      '</div>';
  }).join('') + '</div>';
}

function questionTitle(reqMark, num, text, multi) {
  let s = '<div class="ttl">';
  if (reqMark) s += '<span class="req">*</span>';
  s += '<span class="num">' + num + '.</span> ' + escapeHtml(text);
  if (multi) s += '<span class="multi-line">(복수선택)</span>';
  s += '</div>';
  return s;
}

function renderQ() {
  const a = state.ans;
  const cfg = state.cfg;
  const Q5_9_KEYS = ['q5','q6','q7','q8','q9'];
  const parts = [];

  // Q1
  parts.push('<div class="q">' +
    questionTitle(true, 1, cfg.q1.title, false) +
    '<div class="opts">' +
      state.lectures.map(l => optHTML(a.lecture_id === l.id, 'onLec('+l.id+')', l.name)).join('') +
    '</div></div>');

  // Q2
  parts.push('<div class="q">' +
    questionTitle(true, 2, cfg.q2.title, false) +
    '<div class="opts">' +
      cfg.q2.options.map((label, i) => optHTML(a.q2 === (i+1), 'onQ2('+(i+1)+')', label)).join('') +
    '</div></div>');

  // Q3 (multi)
  parts.push('<div class="q">' +
    questionTitle(true, 3, cfg.q3.title, true) +
    '<div class="opts">' +
      cfg.q3.options.map((label, i) => optHTML(a.q3.includes(i+1), 'onQ3('+(i+1)+')', label)).join('') +
      '<div class="etc-input'+(a.q3.includes(4)?' show':'')+'"><input type="text" placeholder="기타 내용을 입력해주세요" oninput="onQ3Etc(this.value)" value="'+escapeHtml(a.q3_etc)+'"></div>' +
    '</div></div>');

  // Q4 (multi)
  parts.push('<div class="q">' +
    questionTitle(true, 4, cfg.q4.title, true) +
    '<div class="opts">' +
      cfg.q4.options.map((label, i) => optHTML(a.q4.includes(i+1), 'onQ4('+(i+1)+')', label)).join('') +
    '</div></div>');

  // Q5-Q9
  Q5_9_KEYS.forEach((qk, i) => {
    parts.push('<div class="q">' +
      questionTitle(true, 5 + i, cfg.q5_9.titles[i], false) +
      scaleHTML(qk, a[qk]) +
      '</div>');
  });

  // Q10
  parts.push('<div class="q">' +
    questionTitle(true, 10, cfg.q10.title, false) +
    '<textarea rows="2" placeholder="답변을 입력해주세요." oninput="onQ10(this.value)">'+escapeHtml(a.q10)+'</textarea>' +
  '</div>');

  return parts.join('');
}

function isValid() {
  const a = state.ans;
  return !!(a.lecture_id && a.q2 && a.q5 && a.q6 && a.q7 && a.q8 && a.q9 && a.q10 && a.q10.trim());
}

window.submitForm = async () => {
  if (state.submitting || !isValid()) return;
  state.submitting = true; render();
  try {
    const a = state.ans;
    const body = {
      lecture_id: a.lecture_id,
      q2_pregnancy: a.q2,
      q3_source: a.q3,
      q3_etc: a.q3.includes(4) ? a.q3_etc : null,
      q4_reason: a.q4,
      q5_time: a.q5, q6_explain: a.q6, q7_curiosity: a.q7,
      q8_satisfaction: a.q8, q9_facility: a.q9,
      q10_text: a.q10 || null,
    };
    const r = await fetch('/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('submit failed');
    state.done = true;
    try {
      const lec = state.lectures.find(l => l.id === a.lecture_id);
      const now = new Date();
      localStorage.setItem(SUBMIT_KEY, JSON.stringify({
        lectureId: a.lecture_id,
        lectureName: lec ? lec.name : '',
        at: now.toISOString(),
      }));
    } catch {}
  } catch (e) {
    alert('제출 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
  } finally {
    state.submitting = false; render();
  }
};

function formatKstDate(iso) {
  try {
    const d = new Date(iso);
    const kst = new Date(d.getTime() + 9*3600*1000);
    const y = kst.getUTCFullYear();
    const m = String(kst.getUTCMonth()+1).padStart(2,'0');
    const dy = String(kst.getUTCDate()).padStart(2,'0');
    const hh = String(kst.getUTCHours()).padStart(2,'0');
    const mm = String(kst.getUTCMinutes()).padStart(2,'0');
    return y+'.'+m+'.'+dy+' '+hh+':'+mm;
  } catch { return ''; }
}

function render() {
  const root = document.getElementById('root');
  if (state.alreadySubmitted && !state.done) {
    const s = state.alreadySubmitted;
    root.innerHTML = '<div class="wrap">'+
      '<div class="done">'+
        '<div class="icon">✅</div>'+
        '<h2>이미 설문에 참여하셨습니다</h2>'+
        '<p style="margin-top:14px">'+escapeHtml(s.lectureName||'')+'</p>'+
        '<p style="font-size:13px;color:#888">참여 일시: '+formatKstDate(s.at)+'</p>'+
        '<p style="margin-top:24px;font-size:13px;color:#666">소중한 의견 감사드립니다.</p>'+
        '<button class="submit" style="margin-top:28px;background:#fff;color:#7c2a5e;border:1.5px solid #7c2a5e;font-size:14px;padding:10px 24px" onclick="startNewSubmission()">다시 참여하기</button>'+
      '</div>'+
      '<footer>강남차 여성병원 건강강좌 만족도 조사</footer>'+
      '</div>';
    return;
  }
  if (state.done) {
    root.innerHTML = '<div class="wrap">'+
      '<div class="done"><div class="icon">🌸</div>'+
      '<h2>설문이 완료되었습니다</h2>'+
      '<p>소중한 의견 감사드립니다.</p>'+
      '<p>강남차 여성병원 건강강좌가</p>'+
      '<p>더 좋아질 수 있도록 하겠습니다.</p></div>'+
      '<footer>강남차 여성병원 건강강좌 만족도 조사</footer>'+
      '</div>';
    return;
  }
  root.innerHTML =
    '<div class="wrap">'+
      '<div class="header-card">'+
        '<div class="top-line"></div>'+
        '<div class="title-area">'+
          '<h1>'+escapeHtml(state.cfg.appTitle)+'</h1>'+
          '<div class="meta">소중한 의견을 남겨주시면 더 나은 강좌를 만드는 데 큰 도움이 됩니다.</div>'+
        '</div>'+
      '</div>'+
      '<div class="req-notice"><b>*</b> 답변 필수</div>'+
      renderQ()+
      '<div class="submit-area">'+
        '<button class="submit" onclick="submitForm()" '+(!isValid()||state.submitting?'disabled':'')+'>'+
          (state.submitting ? '제출 중...' : '제출')+
        '</button>'+
      '</div>'+
      '<footer>'+escapeHtml(state.cfg.appTitle)+'</footer>'+
    '</div>';
}

checkAlreadySubmitted();
loadInitial();
</script>
</body>
</html>`;

// ============================================================================
// HTML: QR 표시 페이지 (강의자가 빔프로젝터에 띄움)
// ============================================================================

const QR_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>건강강좌 만족도 조사 — QR 안내</title>
${PWA_HEAD_TAGS}
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", system-ui, sans-serif;
    background: linear-gradient(180deg, #fdf3f8 0%, #fff 100%);
    color: #2b2b2b;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4vh 4vw;
    text-align: center;
    overflow: hidden;
  }
  .brand {
    color: #7c2a5e;
    font-size: clamp(20px, 2.4vw, 30px);
    font-weight: 600;
    letter-spacing: -0.5px;
    margin-bottom: clamp(12px, 1.5vh, 24px);
    opacity: 0.85;
  }
  h1 {
    margin: 0 0 clamp(20px, 3vh, 40px);
    color: #2b2b2b;
    font-size: clamp(34px, 5.5vw, 72px);
    font-weight: 800;
    line-height: 1.25;
    letter-spacing: -1.5px;
    max-width: 1200px;
  }
  .sub {
    margin: 0 0 clamp(28px, 4vh, 60px);
    color: #555;
    font-size: clamp(18px, 2.2vw, 32px);
    font-weight: 500;
  }
  .sub b { color: #7c2a5e; }
  .qr-frame {
    background: #fff;
    padding: clamp(20px, 2.5vw, 32px);
    border-radius: 20px;
    box-shadow: 0 8px 40px rgba(124, 42, 94, 0.15);
    border: 2px solid #f0e5ee;
  }
  .qr-frame svg {
    display: block;
    width: clamp(280px, min(56vh, 56vw), 720px);
    height: auto;
  }
  .url {
    margin: clamp(24px, 3.5vh, 48px) 0 0;
    color: #888;
    font-size: clamp(14px, 1.6vw, 22px);
  }
  .url b {
    color: #7c2a5e;
    font-weight: 700;
    font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
    background: #fdf3f8;
    padding: 4px 12px;
    border-radius: 6px;
    margin-left: 6px;
  }
  .footer {
    position: fixed;
    bottom: 16px;
    left: 0; right: 0;
    text-align: center;
    color: #aaa;
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="brand" id="brand">강남차 여성병원</div>
  <h1 id="title">건강강좌 프로그램<br>만족도 조사</h1>
  <div class="sub">QR 코드를 스캔해서 <b>설문에 참여</b>해 주세요</div>
  <div class="qr-frame"><div id="qr"></div></div>
  <div class="url">또는 주소 입력: <b id="url-text"></b></div>
  <div class="footer">소중한 의견 감사드립니다 🌸</div>
<script>
  const surveyUrl = window.location.origin + '/';
  document.getElementById('url-text').textContent = surveyUrl.replace(/^https?:\\/\\//, '');
  // QR 생성: 에러보정 H (30%) — 스캔 안정성 ↑
  const qr = qrcode(0, 'H');
  qr.addData(surveyUrl);
  qr.make();
  document.getElementById('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });

  // 동적 타이틀
  fetch('/api/survey-config').then(r=>r.json()).then(d=>{
    const c = d.config || {};
    if (c.brandLine) document.getElementById('brand').textContent = c.brandLine;
    if (c.appTitle) {
      document.getElementById('title').textContent = c.appTitle;
      document.title = c.appTitle + ' — QR 안내';
    }
  }).catch(()=>{});
</script>
</body>
</html>`;

// ============================================================================
// HTML: 관리자 대시보드
// ============================================================================

const ADMIN_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>건강강좌 설문 관리자</title>
${PWA_HEAD_TAGS}
<script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
<style>
  :root { --p:#7c2a5e; --bg:#fafafa; --bd:#e5e5e5; --tx:#222; --mu:#777; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",system-ui,sans-serif;background:var(--bg);color:var(--tx);font-size:14px}
  .wrap{max-width:1200px;margin:0 auto;padding:20px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid var(--bd)}
  header h1{margin:0;font-size:20px;color:var(--p)}
  .login-wrap{max-width:520px;margin:40px auto;padding:0 16px}
  .login{padding:32px;background:#fff;border:1px solid var(--bd);border-radius:12px}
  .login h2{margin:0 0 20px;color:var(--p);text-align:center}
  .login input{width:100%;padding:12px;border:1.5px solid var(--bd);border-radius:8px;font-size:15px;margin-bottom:12px}
  .login button{width:100%;padding:12px;border:0;background:var(--p);color:#fff;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  /* PWA 설치 안내 */
  .install-card{background:#fff;border:1px solid var(--bd);border-radius:12px;padding:18px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .install-card .head{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
  .install-card .head .icon{font-size:32px;line-height:1}
  .install-card .head .ttl{font-weight:700;color:var(--p);font-size:15px;margin-bottom:3px}
  .install-card .head .desc{color:#666;font-size:13px;line-height:1.5}
  .install-card .close{margin-left:auto;background:none;border:0;color:#aaa;font-size:20px;cursor:pointer;padding:0 4px;width:auto;font-weight:300}
  .install-tabs{display:flex;gap:0;border-bottom:1px solid var(--bd);margin-bottom:12px}
  .install-tab{flex:1;padding:8px 4px;border:0;background:none;cursor:pointer;color:#888;font-size:13px;border-bottom:2px solid transparent;font-weight:500;width:auto}
  .install-tab.active{color:var(--p);border-bottom-color:var(--p);font-weight:600}
  .install-content{font-size:13px;line-height:1.7;color:#333}
  .install-content ol{padding-left:20px;margin:8px 0}
  .install-content li{margin-bottom:6px}
  .install-content b{color:var(--p)}
  .install-content .note{margin-top:10px;padding:8px 12px;background:#fdf3f8;border-radius:6px;color:#666;font-size:12px;line-height:1.6}
  .install-btn{display:inline-block;width:auto;margin-top:8px;padding:10px 18px;border:0;background:var(--p);color:#fff;border-radius:6px;font-weight:600;font-size:14px;cursor:pointer}
  .install-btn:disabled{background:#bbb;cursor:not-allowed}
  .tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--bd)}
  .tab{padding:10px 16px;border:0;background:none;cursor:pointer;font-size:14px;font-weight:500;color:var(--mu);border-bottom:2px solid transparent}
  .tab.active{color:var(--p);border-bottom-color:var(--p)}
  .ctrls{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
  .ctrls select, .ctrls input{padding:8px 10px;border:1.5px solid var(--bd);border-radius:6px;font-size:14px;background:#fff}
  .ctrls button{padding:8px 14px;border:1.5px solid var(--p);background:#fff;color:var(--p);border-radius:6px;cursor:pointer;font-size:14px;font-weight:500}
  .ctrls button.primary{background:var(--p);color:#fff}
  .card{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:14px}
  .card h3{margin:0 0 12px;font-size:15px}
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
  .summary .stat{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:14px}
  .summary .stat .lbl{color:var(--mu);font-size:12px;margin-bottom:6px}
  .summary .stat .val{font-size:24px;font-weight:700;color:var(--p)}
  .summary .stat .sub{color:var(--mu);font-size:12px;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th, td{padding:8px 6px;border:1px solid var(--bd);text-align:center}
  th{background:#f5f0f3;color:var(--p);font-weight:600}
  td.l{text-align:left}
  td.q{background:#fafafa;font-weight:600;text-align:left}
  .pct{font-weight:700;color:var(--p)}
  .comment{padding:8px 12px;border-bottom:1px solid #eee;font-size:13px;line-height:1.5}
  .comment .meta{color:var(--mu);font-size:11px;margin-bottom:2px}
  .empty{text-align:center;padding:40px;color:var(--mu)}
  .group{margin-bottom:24px}
  .group h4{margin:0 0 8px;color:var(--p);font-size:13px}
  .small{font-size:12px;color:var(--mu)}
  /* Charts */
  .charts-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:14px}
  .chart-card{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:14px}
  .chart-card.full{grid-column:1 / -1}
  .chart-card .chart-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .chart-card h4{margin:0;font-size:14px;color:var(--tx);font-weight:600}
  .chart-card .save-btn{padding:5px 10px;border:1px solid var(--bd);background:#fff;color:var(--mu);border-radius:5px;font-size:11px;cursor:pointer}
  .chart-card .save-btn:hover{border-color:var(--p);color:var(--p)}
  .chart-card .canvas-wrap{position:relative;width:100%;height:280px}
  .chart-card.tall .canvas-wrap{height:340px}
  .chart-card.donut .canvas-wrap{height:360px}
  @media (max-width: 768px) {
    .charts-grid{grid-template-columns:1fr}
  }
  @media (max-width: 640px) {
    .summary{grid-template-columns:repeat(2,1fr)}
    table{font-size:11px}
    th, td{padding:5px 3px}
  }
</style>
</head>
<body>
<div id="root"><div class="login"><h2>관리자 로그인</h2><div style="text-align:center;color:#777">로딩...</div></div></div>
<script>
const S = {
  pwd: localStorage.getItem('admin_pwd') || '',
  authed: false,
  installDismissed: localStorage.getItem('install_dismissed') === '1',
  installTab: null,
  tab: 'monthly',
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  quarter: Math.ceil((new Date().getMonth() + 1) / 3),
  lectureId: null,
  lectures: [],
  data: null,
  loading: false,
  availableMonths: [],
};

// 기본 라벨 (config 로드 전 fallback)
let Q2_LABELS = { 1:'첫째', 2:'둘째', 3:'셋째 이상', 4:'해당없음' };
let Q3_LABELS = { 1:'병원 직원의 안내', 2:'온라인에서 정보 습득', 3:'지인 추천', 4:'기타' };
let Q4_LABELS = { 1:'임신 및 출산에 도움', 2:'평소 관심 있는 주제', 3:'가족 및 지인 추천', 4:'강남차병원 교육의 신뢰' };
let Q5_9_TITLES = ['교육 진행시간 적절성','내용 이해 용이성','궁금증 해소','만족도·추천 의향','장소·시설'];
let SURVEY_CFG = null;

function applyConfigLabels(cfg) {
  if (!cfg) return;
  SURVEY_CFG = cfg;
  if (cfg.q2 && Array.isArray(cfg.q2.options)) Q2_LABELS = { 1: cfg.q2.options[0], 2: cfg.q2.options[1], 3: cfg.q2.options[2], 4: cfg.q2.options[3] };
  if (cfg.q3 && Array.isArray(cfg.q3.options)) Q3_LABELS = { 1: cfg.q3.options[0], 2: cfg.q3.options[1], 3: cfg.q3.options[2], 4: cfg.q3.options[3] };
  if (cfg.q4 && Array.isArray(cfg.q4.options)) Q4_LABELS = { 1: cfg.q4.options[0], 2: cfg.q4.options[1], 3: cfg.q4.options[2], 4: cfg.q4.options[3] };
  if (cfg.q5_9 && Array.isArray(cfg.q5_9.titles)) Q5_9_TITLES = cfg.q5_9.titles.slice(0, 5);
}

function escHtml(s) { return String(s||'').replace(/[&<>"']/g, (c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function authedFetch(path) {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + S.pwd } });
  if (r.status === 401) { S.authed = false; localStorage.removeItem('admin_pwd'); render(); throw new Error('auth'); }
  return r.json();
}

async function tryLogin() {
  const v = document.getElementById('pwd-input').value;
  S.pwd = v;
  try {
    const d = await authedFetch('/api/admin/months');
    S.authed = true;
    S.availableMonths = d.months || [];
    localStorage.setItem('admin_pwd', v);
    if (S.availableMonths.length) {
      S.year = S.availableMonths[0].year;
      S.month = S.availableMonths[0].month;
      S.quarter = Math.ceil(S.month / 3);
    }
    await loadConfig();
    await loadLectures();
    await reload();
  } catch {
    alert('비밀번호가 올바르지 않습니다');
  }
}

async function loadConfig() {
  try {
    const r = await fetch('/api/survey-config');
    const d = await r.json();
    if (d.config) applyConfigLabels(d.config);
  } catch {}
}

async function loadLectures() {
  const r = await fetch('/api/lectures');
  const d = await r.json();
  S.lectures = d.lectures || [];
  if (!S.lectureId && S.lectures.length) S.lectureId = S.lectures[0].id;
}

async function reload() {
  if (!S.authed) return;
  S.loading = true; render();
  let url = '/api/admin/stats?period=' + S.tab;
  if (S.tab === 'monthly') url += '&year=' + S.year + '&month=' + S.month;
  else if (S.tab === 'quarterly') url += '&year=' + S.year + '&quarter=' + S.quarter;
  else if (S.tab === 'lecture') {
    url += '&lecture_id=' + S.lectureId;
    if (S.fromYM) url += '&from=' + S.fromYM;
    if (S.toYM) url += '&to=' + S.toYM;
  }
  else if (S.tab === 'all') {
    if (S.fromYM) url += '&from=' + S.fromYM;
    if (S.toYM) url += '&to=' + S.toYM;
  }
  if ((S.tab === 'monthly' || S.tab === 'quarterly') && S.filterLectureId) {
    url += '&filter_lecture_id=' + S.filterLectureId;
  }
  try {
    S.data = await authedFetch(url);
  } catch {
    S.data = null;
  }
  S.loading = false; render();
}

async function setTab(t) {
  S.tab = t;
  if (t === 'manage_lectures') {
    await loadAllLectures();
    render();
  } else if (t === 'edit_survey') {
    await loadConfig();
    S.configEdit = JSON.parse(JSON.stringify(SURVEY_CFG || {}));
    render();
  } else {
    await reload();
  }
}
window.setTab = setTab;

async function loadAllLectures() {
  try {
    const d = await authedFetch('/api/admin/lectures');
    S.allLectures = d.lectures || [];
  } catch {
    S.allLectures = [];
  }
}
window.tryLogin = tryLogin;
window.reload = reload;

window.onYear = (e) => { S.year = +e.target.value; reload(); };
window.onMonth = (e) => { S.month = +e.target.value; reload(); };
window.onQuarter = (e) => { S.quarter = +e.target.value; reload(); };
window.onLecture = (e) => { S.lectureId = +e.target.value; reload(); };
window.onFilterLecture = (e) => { S.filterLectureId = +e.target.value || 0; reload(); };
window.onFromYM = (e) => { S.fromYM = e.target.value || ''; reload(); };
window.onToYM = (e) => { S.toYM = e.target.value || ''; reload(); };
window.clearRange = () => { S.fromYM = ''; S.toYM = ''; reload(); };

window.logout = () => { localStorage.removeItem('admin_pwd'); S.pwd=''; S.authed=false; render(); };

window.changePassword = async () => {
  const newPwd = prompt('새 비밀번호 (4자 이상):');
  if (newPwd == null) return;
  if (newPwd.length < 4) { alert('4자 이상 입력해주세요'); return; }
  const confirm = prompt('새 비밀번호 다시 입력:');
  if (newPwd !== confirm) { alert('비밀번호가 일치하지 않습니다'); return; }
  try {
    const r = await fetch('/api/admin/change-password', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + S.pwd, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new: newPwd }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    S.pwd = newPwd;
    localStorage.setItem('admin_pwd', newPwd);
    alert('비밀번호가 변경되었습니다');
  } catch (e) {
    alert('비밀번호 변경 실패: ' + (e.message || ''));
  }
};

// ===== Excel 다운로드 (ExcelJS — 차트 이미지 + 서식 적용) =====
window.downloadExcel = async () => {
  if (!S.data) return;
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 생성 중...'; }
  try {
    const d = S.data;
    const wb = new ExcelJS.Workbook();
    wb.creator = '강남차 여성병원';
    wb.created = new Date();
    buildSummarySheet(wb, d);
    buildQ234Sheet(wb, d);
    await buildChartsSheet(wb, d);
    buildResponsesSheet(wb, d);
    buildCommentsSheet(wb, d);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '건강강좌 설문결과(' + (d.label || '집계') + ').xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('엑셀 생성 실패: ' + (e.message || ''));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Excel 다운로드'; }
  }
};

const XL_COLOR = { primary: 'FF7C2A5E', soft: 'FFFDF3F8', strip: 'FFF5F0F3', white: 'FFFFFFFF', border: 'FFE5E5E5' };

function xlBorder() {
  return { top:{style:'thin',color:{argb:XL_COLOR.border}}, bottom:{style:'thin',color:{argb:XL_COLOR.border}}, left:{style:'thin',color:{argb:XL_COLOR.border}}, right:{style:'thin',color:{argb:XL_COLOR.border}} };
}

function buildSummarySheet(wb, d) {
  const ws = wb.addWorksheet((d.label || '집계').slice(0, 31));
  const lectures = d.lectures.filter(l => l.active === 1 || (d.lectureCounts && d.lectureCounts[l.id] > 0));
  const ncol = 4 + lectures.length;

  // 타이틀
  ws.mergeCells(1, 1, 1, ncol);
  const t = ws.getCell(1, 1);
  t.value = '건강강좌 설문결과 점수 (' + (d.label || '') + ')';
  t.font = { bold: true, size: 16, color: { argb: XL_COLOR.white } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 32;

  // KPI
  ws.mergeCells(2, 1, 2, ncol);
  const kpi = ws.getCell(2, 1);
  kpi.value = '만족도 ' + d.summary.percent.toFixed(1) + '%   |   응답자 ' + d.respondents + '명   |   총점 ' + d.summary.totalScore + ' / ' + d.summary.maxScore;
  kpi.font = { bold: true, size: 13, color: { argb: XL_COLOR.primary } };
  kpi.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 24;

  // 헤더 행
  const startRow = 4;
  const hdr = ws.getRow(startRow);
  hdr.getCell(1).value = '문항';
  hdr.getCell(2).value = '응답';
  hdr.getCell(3).value = '점수';
  for (let i = 0; i < lectures.length; i++) hdr.getCell(4 + i).value = lectures[i].symbol + '\\n' + lectures[i].name;
  hdr.getCell(4 + lectures.length).value = '점수합\\n응답자수';
  for (let c = 1; c <= ncol; c++) {
    const cell = hdr.getCell(c);
    cell.font = { bold: true, color: { argb: XL_COLOR.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = xlBorder();
  }
  hdr.height = 38;

  const QS = [
    { k: 'q5_time', t: '5. 교육 진행시간 적절성' },
    { k: 'q6_explain', t: '6. 내용 이해 용이성' },
    { k: 'q7_curiosity', t: '7. 궁금증 해소' },
    { k: 'q8_satisfaction', t: '8. 만족도·추천 의향' },
    { k: 'q9_facility', t: '9. 장소·시설' },
  ];
  const scoreLevels = [{s:5,l:'매우그렇다'},{s:4,l:'그렇다'},{s:3,l:'보통이다'}];

  let row = startRow + 1;
  for (const Q of QS) {
    const M = d.matrix[Q.k];
    let qScoreSum = 0, qCountSum = 0;
    // 문항 라벨은 3행 병합
    ws.mergeCells(row, 1, row + 2, 1);
    const qCell = ws.getCell(row, 1);
    qCell.value = Q.t;
    qCell.font = { bold: true, color: { argb: XL_COLOR.primary } };
    qCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.soft } };
    qCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    qCell.border = xlBorder();

    for (let i = 0; i < scoreLevels.length; i++) {
      const sl = scoreLevels[i];
      const r = ws.getRow(row + i);
      r.getCell(2).value = sl.l;
      r.getCell(3).value = sl.s + '점';
      let scoreSum = 0, countSum = 0;
      for (let j = 0; j < lectures.length; j++) {
        const c = (M.byLecture[lectures[j].id] && M.byLecture[lectures[j].id][sl.s]) || 0;
        r.getCell(4 + j).value = c || '';
        scoreSum += c * sl.s;
        countSum += c;
      }
      r.getCell(4 + lectures.length).value = scoreSum + ' / ' + countSum;
      qScoreSum += scoreSum;
      qCountSum += countSum;
      for (let c = 2; c <= ncol; c++) {
        r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
        r.getCell(c).border = xlBorder();
      }
    }
    row += 3;
    // 소계
    const sub = ws.getRow(row);
    ws.mergeCells(row, 1, row, 3);
    sub.getCell(1).value = '항목 소계';
    sub.getCell(1).font = { bold: true };
    sub.getCell(1).alignment = { horizontal: 'center' };
    sub.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.strip } };
    sub.getCell(4 + lectures.length).value = qScoreSum + ' / ' + qCountSum;
    sub.getCell(4 + lectures.length).font = { bold: true, color: { argb: XL_COLOR.primary } };
    sub.getCell(4 + lectures.length).alignment = { horizontal: 'center' };
    for (let c = 1; c <= ncol; c++) sub.getCell(c).border = xlBorder();
    row++;
  }

  // 총합
  const sumRow = ws.getRow(row);
  ws.mergeCells(row, 1, row, 3);
  sumRow.getCell(1).value = '총 합계';
  sumRow.getCell(1).font = { bold: true, color: { argb: XL_COLOR.white }, size: 12 };
  sumRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
  sumRow.getCell(1).alignment = { horizontal: 'center' };
  sumRow.getCell(4 + lectures.length).value = d.summary.totalScore + ' / ' + (d.respondents * 5);
  sumRow.getCell(4 + lectures.length).font = { bold: true, color: { argb: XL_COLOR.white }, size: 12 };
  sumRow.getCell(4 + lectures.length).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
  sumRow.getCell(4 + lectures.length).alignment = { horizontal: 'center' };
  for (let c = 1; c <= ncol; c++) sumRow.getCell(c).border = xlBorder();
  sumRow.height = 26;
  row += 2;

  // 만족도 박스
  ws.mergeCells(row, 1, row, ncol);
  const pct = ws.getCell(row, 1);
  pct.value = '만족도 = ' + d.summary.totalScore + ' ÷ ' + d.summary.maxScore + ' × 100 = ' + d.summary.percent.toFixed(1) + '%';
  pct.font = { bold: true, size: 14, color: { argb: XL_COLOR.primary } };
  pct.alignment = { horizontal: 'center', vertical: 'middle' };
  pct.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.soft } };
  pct.border = xlBorder();
  ws.getRow(row).height = 30;

  // 컬럼 너비
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 8;
  for (let i = 0; i < lectures.length; i++) ws.getColumn(4 + i).width = 12;
  ws.getColumn(4 + lectures.length).width = 14;
}

function buildQ234Sheet(wb, d) {
  const ws = wb.addWorksheet('문항 1~4 분포');
  let row = 1;
  function section(title, labels, counts) {
    ws.mergeCells(row, 1, row, 5);
    const t = ws.getCell(row, 1);
    t.value = title;
    t.font = { bold: true, size: 13, color: { argb: XL_COLOR.white } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
    t.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(row).height = 24;
    row++;
    const hdr = ws.getRow(row);
    for (let i = 0; i < labels.length; i++) {
      hdr.getCell(1 + i).value = labels[i];
      hdr.getCell(1 + i).font = { bold: true };
      hdr.getCell(1 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.soft } };
      hdr.getCell(1 + i).alignment = { horizontal: 'center' };
      hdr.getCell(1 + i).border = xlBorder();
    }
    row++;
    const r = ws.getRow(row);
    for (let i = 0; i < counts.length; i++) {
      r.getCell(1 + i).value = counts[i] + '명';
      r.getCell(1 + i).alignment = { horizontal: 'center' };
      r.getCell(1 + i).border = xlBorder();
    }
    row += 2;
  }
  section('2. 임신 여부', ['첫째','둘째','셋째 이상','해당없음'], [d.q2Counts[1]||0, d.q2Counts[2]||0, d.q2Counts[3]||0, d.q2Counts[4]||0]);
  section('3. 신청 경로 (중복선택)', ['병원 직원 안내','온라인','지인 추천','기타'], [d.q3Counts[1]||0, d.q3Counts[2]||0, d.q3Counts[3]||0, d.q3Counts[4]||0]);
  section('4. 신청 이유 (중복선택)', ['임신·출산 도움','평소 관심 주제','가족·지인 추천','강남차병원 신뢰'], [d.q4Counts[1]||0, d.q4Counts[2]||0, d.q4Counts[3]||0, d.q4Counts[4]||0]);
  for (let c = 1; c <= 5; c++) ws.getColumn(c).width = 22;
}

async function buildChartsSheet(wb, d) {
  const ws = wb.addWorksheet('차트');
  ws.getColumn(1).width = 4;
  const chartList = [
    { id: 'chart-questions', t: '📊 문항별 점수 분포' },
    { id: 'chart-lectures', t: '📚 강좌별 응답자 수' },
    { id: 'chart-q2', t: '🤰 임신 단계 분포' },
    { id: 'chart-q3', t: '📣 신청 경로' },
    { id: 'chart-q4', t: '💡 신청 이유' },
    { id: 'chart-satisfaction', t: '⭐ 5문항 평균 만족도 (레이더)' },
    { id: 'chart-trend', t: '📈 만족도 추이' },
  ];
  let curRow = 1;
  for (const ch of chartList) {
    const canvas = document.getElementById(ch.id);
    if (!canvas) continue;
    // 타이틀
    ws.mergeCells(curRow, 2, curRow, 12);
    const t = ws.getCell(curRow, 2);
    t.value = ch.t + '   —   ' + (d.label || '');
    t.font = { bold: true, size: 13, color: { argb: XL_COLOR.primary } };
    t.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(curRow).height = 22;
    curRow++;
    // 이미지 (흰 배경)
    const dataUrl = chartImageDataUrl(canvas);
    const b64 = dataUrl.split(',')[1];
    const imageId = wb.addImage({ base64: b64, extension: 'png' });
    const w = canvas.width;
    const h = canvas.height;
    const targetW = 720;
    const targetH = Math.round((h / w) * targetW);
    ws.addImage(imageId, {
      tl: { col: 1, row: curRow - 1 },
      ext: { width: targetW, height: targetH },
    });
    const rowsTaken = Math.ceil(targetH / 18) + 2; // 18px per row default
    curRow += rowsTaken;
  }
}

function chartImageDataUrl(canvas) {
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  return tmp.toDataURL('image/png', 1.0);
}

function buildResponsesSheet(wb, d) {
  const ws = wb.addWorksheet('개별응답');
  const headers = ['번호','강좌','응답일','임신','신청경로','기타','신청이유','Q5','Q6','Q7','Q8','Q9','자유서술'];
  const hdr = ws.getRow(1);
  for (let i = 0; i < headers.length; i++) {
    const c = hdr.getCell(i + 1);
    c.value = headers[i];
    c.font = { bold: true, color: { argb: XL_COLOR.white } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
    c.alignment = { horizontal: 'center' };
    c.border = xlBorder();
  }
  hdr.height = 22;
  d.rows.forEach((r, i) => {
    const row = ws.getRow(2 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.lecture_symbol + ' ' + r.lecture_name;
    row.getCell(3).value = r.year + '-' + String(r.month).padStart(2,'0') + '-' + String(r.day).padStart(2,'0');
    row.getCell(4).value = Q2_LABELS[r.q2_pregnancy] || '';
    row.getCell(5).value = (r.q3_source || []).map(v => Q3_LABELS[v]).join(', ');
    row.getCell(6).value = r.q3_etc || '';
    row.getCell(7).value = (r.q4_reason || []).map(v => Q4_LABELS[v]).join(', ');
    row.getCell(8).value = r.q5_time;
    row.getCell(9).value = r.q6_explain;
    row.getCell(10).value = r.q7_curiosity;
    row.getCell(11).value = r.q8_satisfaction;
    row.getCell(12).value = r.q9_facility;
    row.getCell(13).value = r.q10_text || '';
    if (i % 2 === 1) {
      for (let c = 1; c <= 13; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
    }
  });
  ws.getColumn(1).width = 6;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 10;
  ws.getColumn(5).width = 26;
  ws.getColumn(6).width = 18;
  ws.getColumn(7).width = 32;
  for (let c = 8; c <= 12; c++) ws.getColumn(c).width = 6;
  ws.getColumn(13).width = 50;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function buildCommentsSheet(wb, d) {
  const ws = wb.addWorksheet('자유서술');
  const hdr = ws.getRow(1);
  ['강좌','응답일','내용'].forEach((h, i) => {
    const c = hdr.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: XL_COLOR.white } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.primary } };
    c.alignment = { horizontal: 'center' };
    c.border = xlBorder();
  });
  d.comments.forEach((c, i) => {
    const row = ws.getRow(2 + i);
    row.getCell(1).value = c.lecture_name;
    row.getCell(2).value = c.year + '-' + String(c.month).padStart(2,'0') + '-' + String(c.day).padStart(2,'0');
    row.getCell(3).value = c.text;
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    if (i % 2 === 1) {
      for (let cc = 1; cc <= 3; cc++) row.getCell(cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
    }
  });
  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 80;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

// ===== PWA 설치 안내 =====
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; if (!S.authed) render(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; localStorage.setItem('pwa_installed','1'); if (!S.authed) render(); });

function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  if (isIOS) return 'ios';
  if (isAndroid) return 'android';
  return 'desktop';
}
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

window.setInstallTab = (t) => { S.installTab = t; render(); };
window.dismissInstall = () => { localStorage.setItem('install_dismissed','1'); S.installDismissed = true; render(); };
window.triggerInstall = async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') deferredInstallPrompt = null;
  render();
};

function renderInstallCard() {
  if (isStandalonePWA() || localStorage.getItem('pwa_installed') === '1' || S.installDismissed) return '';
  const platform = S.installTab || detectPlatform();
  const tab = (k, l) => '<button class="install-tab'+(platform===k?' active':'')+'" onclick="setInstallTab(\\''+k+'\\')">'+l+'</button>';
  const canInstall = !!deferredInstallPrompt;

  let content = '';
  if (platform === 'android') {
    content = '<ol>'+
      '<li><b>Chrome 브라우저</b>로 이 페이지를 열어주세요</li>'+
      '<li>아래 <b>[설치하기]</b> 버튼을 누르세요'+(canInstall?'':' (버튼이 없으면 화면 우측 상단의 <b>⋮</b> 메뉴 → <b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b>를 누르세요)')+'</li>'+
      '<li><b>[설치]</b> 또는 <b>[추가]</b>를 누르면 끝!</li>'+
      '<li>스마트폰 홈 화면에서 <b>${APP_SHORT_NAME}</b> 아이콘을 찾아 누르면 바로 들어옵니다</li>'+
      '</ol>'+
      (canInstall ? '<button class="install-btn" onclick="triggerInstall()">📥 설치하기</button>' : '<div class="note">설치 버튼이 안 보이면 우측 상단 <b>⋮</b> 메뉴를 직접 눌러주세요.</div>');
  } else if (platform === 'ios') {
    content = '<ol>'+
      '<li><b>Safari 브라우저</b>로 이 페이지를 열어주세요 <span style="color:#c33">(중요: Chrome·삼성 브라우저는 안 됩니다)</span></li>'+
      '<li>화면 <b>아래 우측의 ⋯ (더보기) 버튼</b>을 누르세요. 그러면 메뉴가 뜨는데, <b>상단에 있는 공유 버튼</b> (네모 + 위 화살표 ⬆️ 모양)을 누르세요</li>'+
      '<li><b>"더보기"</b>를 누르거나 화면을 <b>아래로 스크롤</b>하면 <b>"홈 화면에 추가"</b>가 보입니다 — 그것을 누르세요</li>'+
      '<li>오른쪽 위의 <b>[추가]</b>를 누르면 끝!</li>'+
      '<li>아이폰 홈 화면에 <b>${APP_SHORT_NAME}</b> 아이콘이 생긴 것을 확인하세요</li>'+
      '</ol>'+
      '<div class="note">아이폰은 자동 설치 버튼이 없어요. 위 순서대로 직접 추가하셔야 합니다.</div>';
  } else {
    content = '<ol>'+
      '<li><b>Chrome 또는 Edge 브라우저</b>로 이 페이지를 열어주세요</li>'+
      '<li>아래 <b>[설치하기]</b> 버튼을 누르세요'+(canInstall?'':' (버튼이 없으면 주소창 오른쪽 끝의 <b>모니터+화살표 아이콘 (⊕)</b>을 눌러주세요)')+'</li>'+
      '<li>"<b>${APP_NAME} 설치</b>" 라는 창이 뜨면 <b>[설치]</b>를 누르세요</li>'+
      '<li>독립된 창이 열리고, 작업표시줄·바탕화면에 아이콘이 생깁니다 — 다음부터는 그 아이콘으로 바로 들어오세요</li>'+
      '</ol>'+
      (canInstall ? '<button class="install-btn" onclick="triggerInstall()">💻 설치하기</button>' : '<div class="note">설치 버튼이 안 보이면 주소창 오른쪽 끝 작은 모니터 모양 아이콘을 눌러주세요. 못 찾겠으면 <b>⋮</b> 메뉴 → "<b>${APP_NAME} 설치</b>"를 클릭.</div>');
  }

  return '<div class="install-card">'+
    '<div class="head">'+
      '<div class="icon">📱</div>'+
      '<div style="flex:1">'+
        '<div class="ttl">홈 화면에 설치해서 앱처럼 사용하세요</div>'+
        '<div class="desc">한 번 설치하면 매번 주소를 입력하지 않아도 됩니다. 사용 중인 기기를 선택해주세요.</div>'+
      '</div>'+
      '<button class="close" onclick="dismissInstall()" title="닫기">×</button>'+
    '</div>'+
    '<div class="install-tabs">'+
      tab('android','📱 안드로이드')+
      tab('ios','🍎 아이폰')+
      tab('desktop','💻 데스크톱')+
    '</div>'+
    '<div class="install-content">'+content+'</div>'+
    '</div>';
}

// ===== 렌더 =====
function render() {
  const root = document.getElementById('root');
  if (!S.authed) {
    root.innerHTML = '<div class="login-wrap">'+
      renderInstallCard()+
      '<div class="login"><h2>관리자 로그인</h2>'+
      '<input id="pwd-input" type="password" placeholder="관리자 비밀번호" onkeypress="if(event.key===\\'Enter\\')tryLogin()">'+
      '<button onclick="tryLogin()">로그인</button></div>'+
      '</div>';
    setTimeout(() => { const i = document.getElementById('pwd-input'); if (i) i.focus(); }, 0);
    return;
  }
  const isManage = (S.tab === 'manage_lectures' || S.tab === 'edit_survey');
  let body;
  if (isManage) {
    if (S.tab === 'manage_lectures') body = renderLectureManagement();
    else if (S.tab === 'edit_survey') body = renderSurveyEdit();
  } else {
    body = renderControls() + (S.loading ? '<div class="empty">불러오는 중...</div>' : (S.data ? renderData() : '<div class="empty">데이터를 불러오지 못했습니다.</div>'));
  }
  root.innerHTML =
    '<div class="wrap">'+
      '<header><h1>건강강좌 만족도 조사 — 관리자</h1>'+
        '<div style="display:flex;gap:6px">'+
          '<button onclick="changePassword()" style="padding:6px 12px;border:1px solid var(--bd);background:#fff;border-radius:6px;cursor:pointer;font-size:13px">🔐 비밀번호 변경</button>'+
          '<button onclick="logout()" style="padding:6px 12px;border:1px solid var(--bd);background:#fff;border-radius:6px;cursor:pointer;font-size:13px">로그아웃</button>'+
        '</div>'+
      '</header>'+
      renderTabs() +
      body +
    '</div>';
  if (!isManage && S.data && !S.loading) {
    setTimeout(() => initCharts(S.data), 0);
  } else {
    destroyCharts();
  }
}

function renderTabs() {
  const tabs = [['monthly','월별 집계'],['quarterly','분기별 집계'],['lecture','강좌별 누적'],['all','전체'],['manage_lectures','🎓 강좌 관리'],['edit_survey','📝 설문 편집']];
  return '<div class="tabs">'+tabs.map(([k,l])=>'<button class="tab'+(S.tab===k?' active':'')+'" onclick="setTab(\\''+k+'\\')">'+l+'</button>').join('')+'</div>';
}

function renderControls() {
  const yearOpts = [];
  const years = new Set([new Date().getFullYear(), ...(S.availableMonths.map(m=>m.year))]);
  for (const y of [...years].sort((a,b)=>b-a)) yearOpts.push('<option value="'+y+'"'+(S.year===y?' selected':'')+'>'+y+'년</option>');

  let c = '<div class="ctrls">';
  if (S.tab === 'monthly') {
    c += renderLectureFilter();
    c += '<select onchange="onYear(event)">'+yearOpts.join('')+'</select>';
    c += '<select onchange="onMonth(event)">';
    for (let m = 1; m <= 12; m++) c += '<option value="'+m+'"'+(S.month===m?' selected':'')+'>'+m+'월</option>';
    c += '</select>';
  } else if (S.tab === 'quarterly') {
    c += renderLectureFilter();
    c += '<select onchange="onYear(event)">'+yearOpts.join('')+'</select>';
    c += '<select onchange="onQuarter(event)">';
    for (let q = 1; q <= 4; q++) c += '<option value="'+q+'"'+(S.quarter===q?' selected':'')+'>'+q+'분기</option>';
    c += '</select>';
  } else if (S.tab === 'lecture') {
    c += '<select onchange="onLecture(event)">';
    for (const l of S.lectures) c += '<option value="'+l.id+'"'+(S.lectureId===l.id?' selected':'')+'>'+escHtml(l.symbol+' '+l.name)+'</option>';
    c += '</select>';
    c += renderPeriodFilter();
  } else if (S.tab === 'all') {
    c += renderPeriodFilter();
  }
  c += '<button onclick="reload()">새로고침</button>';
  c += '<button class="primary" onclick="downloadExcel()">📥 Excel 다운로드</button>';
  c += '</div>';
  return c;
}

function renderLectureFilter() {
  let h = '<select onchange="onFilterLecture(event)" style="min-width:170px">';
  h += '<option value="0"'+(S.filterLectureId?'':' selected')+'>📚 전체 강좌</option>';
  for (const l of (S.lectures || [])) {
    h += '<option value="'+l.id+'"'+(S.filterLectureId===l.id?' selected':'')+'>'+escHtml(l.symbol+' '+l.name)+'</option>';
  }
  h += '</select>';
  return h;
}

function renderPeriodFilter() {
  // 사용 가능한 (year, month) 목록 (오름차순)
  const months = (S.availableMonths || []).slice().sort((a,b) => (a.year - b.year) || (a.month - b.month));
  const opt = (m, sel) => {
    const v = m.year + '-' + String(m.month).padStart(2,'0');
    return '<option value="'+v+'"'+(sel===v?' selected':'')+'>'+m.year+'년 '+m.month+'월</option>';
  };
  let h = '<span style="font-size:13px;color:#777;margin:0 4px">📅</span>';
  h += '<select onchange="onFromYM(event)" style="min-width:130px">';
  h += '<option value=""'+(!S.fromYM?' selected':'')+'>처음부터</option>';
  for (const m of months) h += opt(m, S.fromYM);
  h += '</select>';
  h += '<span style="margin:0 6px;color:#777">~</span>';
  h += '<select onchange="onToYM(event)" style="min-width:130px">';
  h += '<option value=""'+(!S.toYM?' selected':'')+'>끝까지</option>';
  for (const m of months) h += opt(m, S.toYM);
  h += '</select>';
  if (S.fromYM || S.toYM) {
    h += '<button onclick="clearRange()" style="padding:4px 8px;font-size:12px;border:1px solid var(--bd);background:#fff;color:var(--mu);border-radius:4px;cursor:pointer">전체 기간</button>';
  }
  return h;
}

function renderData() {
  const d = S.data;
  if (!d || d.respondents === 0) {
    return '<div class="empty">📊 해당 기간에 응답이 없습니다.<br><span class="small">'+escHtml(d?.label||'')+'</span></div>';
  }
  return renderSummary(d) + renderCharts(d) + renderMatrix(d) + renderQ234(d) + renderComments(d);
}

function renderCharts(d) {
  const showTrend = d.period === 'quarterly' || d.period === 'all' || d.period === 'lecture';
  let h = '<div class="charts-grid">';
  h += chartCard('chart-questions', '📊 문항별 점수 분포', '문항별점수분포', false, true);
  h += chartCard('chart-lectures', '📚 강좌별 응답자 수', '강좌별응답자수', false, true);
  h += chartCard('chart-q2', '🤰 임신 단계 분포 (Q2)', '임신단계', false, false, true);
  h += chartCard('chart-q3', '📣 신청 경로 (Q3, 중복)', '신청경로', false, false, true);
  h += chartCard('chart-q4', '💡 신청 이유 (Q4, 중복)', '신청이유', false, false, true);
  h += chartCard('chart-satisfaction', '⭐ 5문항 평균 만족도', '평균만족도', false, false, false);
  if (showTrend) {
    h += chartCard('chart-trend', '📈 ' + (d.period === 'lecture' ? '회차별 만족도 추이' : '월별 만족도 추이'), '만족도추이', true, true);
  }
  h += '</div>';
  return h;
}

function chartCard(id, title, savename, full, tall, donut) {
  const cls = 'chart-card' + (full ? ' full' : '') + (tall ? ' tall' : '') + (donut ? ' donut' : '');
  return '<div class="' + cls + '">'+
    '<div class="chart-head"><h4>'+title+'</h4>'+
      '<button class="save-btn" onclick="downloadChart(\\''+id+'\\',\\''+savename+'\\')">🖼 이미지 저장</button>'+
    '</div>'+
    '<div class="canvas-wrap"><canvas id="'+id+'"></canvas></div>'+
  '</div>';
}

const COLORS = {
  primary: '#7c2a5e',
  secondary: '#a83e7e',
  tertiary: '#c577a7',
  light: '#d4a4c2',
  pale: '#ead5e0',
  donut: ['#7c2a5e', '#a83e7e', '#c577a7', '#d4a4c2', '#ead5e0', '#9b6788'],
};

const chartInstances = {};

function destroyCharts() {
  for (const k in chartInstances) {
    try { chartInstances[k].destroy(); } catch {}
    delete chartInstances[k];
  }
}

window.downloadChart = (id, name) => {
  const c = document.getElementById(id);
  if (!c) return;
  // 흰 배경 + 2배 해상도로 저장 (PPT용)
  const tmp = document.createElement('canvas');
  const scale = 2;
  tmp.width = c.width;
  tmp.height = c.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(c, 0, 0);
  const url = tmp.toDataURL('image/png', 1.0);
  const a = document.createElement('a');
  a.href = url;
  a.download = (name || 'chart') + '_' + (S.data?.label || '') + '.png';
  document.body.appendChild(a); a.click(); a.remove();
};

function fmtNum(v) {
  if (v == null) return '';
  if (Number.isInteger(v)) return v;
  return v.toFixed(1);
}

function _roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// 작은 도넛 슬라이스의 라벨을 외부에 callout 스타일로 배치 (충돌 회피)
const SmallSliceLabelsPlugin = {
  id: 'smallSliceLabels',
  afterDatasetsDraw(chart) {
    if (chart.config.type !== 'doughnut' && chart.config.type !== 'pie') return;
    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(0);
    const dataset = chart.data.datasets[0];
    const total = dataset.data.reduce((a, b) => a + b, 0);
    if (!total) return;
    const arcs = meta.data;
    const chartArea = chart.chartArea;

    // 작은 슬라이스 수집 (8% 미만)
    const smalls = [];
    arcs.forEach((arc, i) => {
      const v = dataset.data[i] || 0;
      if (!v) return;
      const ratio = v / total;
      if (ratio >= 0.08) return;
      let angle = (arc.startAngle + arc.endAngle) / 2;
      // 정규화 [-PI, PI]
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;
      smalls.push({ arc, v, ratio, idx: i, angle });
    });
    if (!smalls.length) return;

    ctx.save();
    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif';

    function placeSide(group, isRight) {
      if (!group.length) return;
      // arc 시작점/이상적 라벨 y 계산
      const items = group.map((g) => {
        const r = g.arc.outerRadius;
        const startX = g.arc.x + Math.cos(g.angle) * r;
        const startY = g.arc.y + Math.sin(g.angle) * r;
        const text = g.v + '명 (' + (g.ratio * 100).toFixed(1) + '%)';
        return { ...g, startX, startY, text, desiredY: g.arc.y + Math.sin(g.angle) * (r + 16) };
      });
      // y로 정렬 후 충돌 방지 분배
      items.sort((a, b) => a.desiredY - b.desiredY);
      const minGap = 20;
      let lastY = chartArea.top + 8;
      for (const it of items) {
        it.placedY = Math.max(it.desiredY, lastY + minGap);
        if (it.placedY > chartArea.bottom - 8) it.placedY = chartArea.bottom - 8;
        lastY = it.placedY;
      }
      // 그리기 (단일 대각선 — 슬라이스에서 라벨로 직선)
      for (const it of items) {
        const cx = it.arc.x;
        const r = it.arc.outerRadius;
        const tw = ctx.measureText(it.text).width + 12;
        const th = 18;
        const labelEdgeX = isRight ? Math.min(chartArea.right - tw - 2, cx + r + 36) : Math.max(chartArea.left + 2, cx - r - 36 - tw);
        const labelMidX = labelEdgeX + tw / 2;
        const labelY = it.placedY;
        const lineEndX = isRight ? labelEdgeX - 2 : labelEdgeX + tw + 2;
        // 라인: 슬라이스 → 라벨 (단일 직선)
        ctx.beginPath();
        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 1;
        ctx.moveTo(it.startX, it.startY);
        ctx.lineTo(lineEndX, labelY);
        ctx.stroke();
        // 시작 점
        ctx.beginPath();
        ctx.fillStyle = '#aaa';
        ctx.arc(it.startX, it.startY, 2, 0, Math.PI * 2);
        ctx.fill();
        // 박스
        _roundRectPath(ctx, labelEdgeX, labelY - th / 2, tw, th, 4);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 텍스트
        ctx.fillStyle = '#444';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(it.text, labelMidX, labelY);
      }
    }

    const left = smalls.filter((s) => Math.cos(s.angle) < 0);
    const right = smalls.filter((s) => Math.cos(s.angle) >= 0);
    placeSide(right, true);
    placeSide(left, false);
    ctx.restore();
  },
};

function initCharts(d) {
  destroyCharts();
  if (!d || d.respondents === 0 || typeof Chart === 'undefined') return;
  if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);
  Chart.register(SmallSliceLabelsPlugin);
  const QS = ['q5_time','q6_explain','q7_curiosity','q8_satisfaction','q9_facility'];
  const Q_LABELS_SHORT = (Q5_9_TITLES || []).map((t, i) => 'Q' + (5 + i) + ' ' + (t || '').replace(/[?!.]+$/, '').slice(0, 10));
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.datalabels = { color: '#fff', font: { weight: '700', size: 11 } };

  // 1) 문항별 점수 분포 (stacked horizontal bar)
  const c1 = document.getElementById('chart-questions');
  if (c1) {
    chartInstances.questions = new Chart(c1, {
      type: 'bar',
      data: {
        labels: Q_LABELS_SHORT,
        datasets: [
          { label: '매우 그렇다 (5점)', backgroundColor: COLORS.primary, data: QS.map(k => d.matrix[k].total[5] || 0) },
          { label: '그렇다 (4점)', backgroundColor: COLORS.tertiary, data: QS.map(k => d.matrix[k].total[4] || 0) },
          { label: '보통이다 (3점)', backgroundColor: COLORS.pale, data: QS.map(k => d.matrix[k].total[3] || 0) },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.x + '명' } },
          datalabels: {
            color: '#fff',
            font: { weight: '700', size: 11 },
            formatter: (v) => v > 0 ? v : '',
          },
        },
        scales: { x: { stacked: true, ticks: { stepSize: 1 } }, y: { stacked: true } },
      },
    });
  }

  // 2) 강좌별 응답자수 (horizontal bar)
  const c2 = document.getElementById('chart-lectures');
  if (c2) {
    const lectures = d.lectures.filter(l => (d.lectureCounts[l.id] || 0) > 0);
    chartInstances.lectures = new Chart(c2, {
      type: 'bar',
      data: {
        labels: lectures.map(l => l.symbol + ' ' + l.name),
        datasets: [{ label: '응답자 수', backgroundColor: COLORS.primary, data: lectures.map(l => d.lectureCounts[l.id]) }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ctx.parsed.x + '명' } },
          datalabels: { color: '#fff', anchor: 'end', align: 'start', offset: 4, font: { weight: '700', size: 12 }, formatter: (v) => v > 0 ? v + '명' : '' },
        },
        scales: { x: { ticks: { stepSize: 1 } } },
      },
    });
  }

  function donutOpts() {
    return {
      responsive: true, maintainAspectRatio: false,
      // 도넛을 작게 그려 외부 라벨 공간 확보
      cutout: '55%',
      radius: '62%',
      layout: { padding: { top: 8, bottom: 8, left: 8, right: 8 } },
      plugins: {
        legend: { position: 'bottom' },
        datalabels: {
          // 큰 슬라이스(8% 이상)만 내부 라벨, 작은 슬라이스는 SmallSliceLabelsPlugin가 처리
          display: (ctx) => {
            const v = ctx.dataset.data[ctx.dataIndex] || 0;
            const total = ctx.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
            return v > 0 && total > 0 && v / total >= 0.08;
          },
          color: '#fff',
          font: { weight: '700', size: 11 },
          formatter: (value, ctx) => {
            const total = ctx.chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
            const pct = total > 0 ? (value / total * 100) : 0;
            return value + '명\\n(' + pct.toFixed(1) + '%)';
          },
          textAlign: 'center',
        },
      },
    };
  }

  // 3) Q2 임신 (donut)
  const c3 = document.getElementById('chart-q2');
  if (c3) {
    chartInstances.q2 = new Chart(c3, {
      type: 'doughnut',
      data: {
        labels: [Q2_LABELS[1], Q2_LABELS[2], Q2_LABELS[3], Q2_LABELS[4]],
        datasets: [{ data: [d.q2Counts[1]||0, d.q2Counts[2]||0, d.q2Counts[3]||0, d.q2Counts[4]||0], backgroundColor: COLORS.donut.slice(0,4) }],
      },
      options: donutOpts(),
    });
  }

  // 4) Q3 신청 경로 (donut)
  const c4 = document.getElementById('chart-q3');
  if (c4) {
    chartInstances.q3 = new Chart(c4, {
      type: 'doughnut',
      data: {
        labels: [Q3_LABELS[1], Q3_LABELS[2], Q3_LABELS[3], Q3_LABELS[4]],
        datasets: [{ data: [d.q3Counts[1]||0, d.q3Counts[2]||0, d.q3Counts[3]||0, d.q3Counts[4]||0], backgroundColor: COLORS.donut.slice(0,4) }],
      },
      options: donutOpts(),
    });
  }

  // 5) Q4 신청 이유 (donut)
  const c5 = document.getElementById('chart-q4');
  if (c5) {
    chartInstances.q4 = new Chart(c5, {
      type: 'doughnut',
      data: {
        labels: [Q4_LABELS[1], Q4_LABELS[2], Q4_LABELS[3], Q4_LABELS[4]],
        datasets: [{ data: [d.q4Counts[1]||0, d.q4Counts[2]||0, d.q4Counts[3]||0, d.q4Counts[4]||0], backgroundColor: COLORS.donut.slice(0,4) }],
      },
      options: donutOpts(),
    });
  }

  // 6) 5문항 평균 만족도 (radar)
  const c6 = document.getElementById('chart-satisfaction');
  if (c6) {
    const avgs = QS.map(k => {
      const tc = d.matrix[k].totalCount || 0;
      const ts = d.matrix[k].totalScore || 0;
      return tc > 0 ? +(ts / tc).toFixed(2) : 0;
    });
    chartInstances.sat = new Chart(c6, {
      type: 'radar',
      data: {
        labels: Q_LABELS_SHORT,
        datasets: [{ label: '평균 점수', data: avgs, backgroundColor: 'rgba(124,42,94,0.2)', borderColor: COLORS.primary, borderWidth: 2, pointBackgroundColor: COLORS.primary }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          datalabels: {
            color: COLORS.primary,
            backgroundColor: '#fff',
            borderColor: COLORS.primary,
            borderWidth: 1,
            borderRadius: 4,
            padding: { top: 2, bottom: 2, left: 6, right: 6 },
            font: { weight: '700', size: 11 },
            formatter: (v) => v.toFixed(1) + '점',
          },
        },
        scales: { r: { min: 3, max: 5, ticks: { stepSize: 0.5 } } },
      },
    });
  }

  // 7) 추이 (분기/전체/강좌별)
  const c7 = document.getElementById('chart-trend');
  if (c7) {
    const buckets = {};
    for (const r of d.rows) {
      let key;
      if (d.period === 'lecture') {
        key = r.year + '-' + String(r.month).padStart(2,'0') + '-' + String(r.day).padStart(2,'0');
      } else {
        key = r.year + '-' + String(r.month).padStart(2,'0');
      }
      if (!buckets[key]) buckets[key] = { count: 0, score: 0 };
      buckets[key].count += 5;
      buckets[key].score += (r.q5_time||0) + (r.q6_explain||0) + (r.q7_curiosity||0) + (r.q8_satisfaction||0) + (r.q9_facility||0);
    }
    const sortedKeys = Object.keys(buckets).sort();
    const percents = sortedKeys.map(k => {
      const b = buckets[k];
      const max = b.count * 5;
      return max > 0 ? +(b.score / max * 100).toFixed(1) : 0;
    });
    const counts = sortedKeys.map(k => buckets[k].count / 5);
    chartInstances.trend = new Chart(c7, {
      type: 'line',
      data: {
        labels: sortedKeys,
        datasets: [
          { label: '만족도 (%)', data: percents, borderColor: COLORS.primary, backgroundColor: 'rgba(124,42,94,0.1)', fill: true, tension: 0.3, yAxisID: 'y', pointRadius: 5, pointBackgroundColor: COLORS.primary, datalabels: { color: COLORS.primary, backgroundColor: '#fff', borderColor: COLORS.primary, borderWidth: 1, borderRadius: 4, padding: { top: 2, bottom: 2, left: 5, right: 5 }, font: { weight: '700', size: 10 }, formatter: (v) => v.toFixed(1) + '%', anchor: 'end', align: 'top' } },
          { label: '응답자 수', data: counts, borderColor: COLORS.tertiary, borderDash: [5,5], yAxisID: 'y1', tension: 0.3, pointRadius: 4, pointBackgroundColor: COLORS.tertiary, datalabels: { color: COLORS.tertiary, font: { size: 10 }, formatter: (v) => v + '명', anchor: 'end', align: 'bottom' } },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y: { type: 'linear', position: 'left', min: 80, max: 100, title: { display: true, text: '만족도 (%)' } },
          y1: { type: 'linear', position: 'right', beginAtZero: true, title: { display: true, text: '응답자 수' }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }
}

function renderSummary(d) {
  return '<div class="summary">'+
    '<div class="stat"><div class="lbl">'+escHtml(d.label)+'</div><div class="val">'+d.summary.percent.toFixed(1)+'%</div><div class="sub">교육 만족도</div></div>'+
    '<div class="stat"><div class="lbl">응답자 수</div><div class="val">'+d.respondents+'</div><div class="sub">'+(d.respondents*5)+'건 응답</div></div>'+
    '<div class="stat"><div class="lbl">총 점수</div><div class="val">'+d.summary.totalScore+'</div><div class="sub">/ '+d.summary.maxScore+'점</div></div>'+
    '<div class="stat"><div class="lbl">자유 서술</div><div class="val">'+d.comments.length+'</div><div class="sub">개의 의견</div></div>'+
    '</div>';
}

function renderMatrix(d) {
  // 강좌별 매트릭스
  const lectures = d.lectures.filter(l => l.active === 1 || (d.lectureCounts && d.lectureCounts[l.id] > 0));
  const QS = [
    { k:'q5_time', t:'5. 교육 진행시간 적절성' },
    { k:'q6_explain', t:'6. 교육 내용 이해 용이성' },
    { k:'q7_curiosity', t:'7. 궁금증 해소' },
    { k:'q8_satisfaction', t:'8. 만족도 및 추천 의향' },
    { k:'q9_facility', t:'9. 장소·시설' },
  ];
  const scaleLabels = [{s:5,l:'매우 그렇다'},{s:4,l:'그렇다'},{s:3,l:'보통'}];
  let h = '<div class="card"><h3>📊 문항별 점수 분포 (강좌별)</h3><div style="overflow-x:auto"><table>';
  // 헤더
  h += '<tr><th rowspan="2">문항</th><th rowspan="2">응답</th>';
  for (const l of lectures) h += '<th>'+escHtml(l.symbol)+'</th>';
  h += '<th rowspan="2">합계</th><th rowspan="2">점수합</th></tr>';
  h += '<tr>';
  for (const l of lectures) h += '<th class="small" style="font-weight:400;font-size:10px">'+escHtml(l.name.slice(0,5))+'</th>';
  h += '</tr>';
  for (const Q of QS) {
    const M = d.matrix[Q.k];
    h += '<tr><td class="q" rowspan="3">'+escHtml(Q.t)+'</td>';
    for (let i = 0; i < scaleLabels.length; i++) {
      const sl = scaleLabels[i];
      if (i > 0) h += '<tr>';
      h += '<td>'+sl.l+' ('+sl.s+')</td>';
      let totalCount = 0;
      let totalScore = 0;
      for (const l of lectures) {
        const c = (M.byLecture[l.id] && M.byLecture[l.id][sl.s]) || 0;
        h += '<td>'+(c || '')+'</td>';
        totalCount += c;
        totalScore += c * sl.s;
      }
      h += '<td><b>'+totalCount+'</b></td><td>'+totalScore+'</td>';
      h += '</tr>';
    }
  }
  h += '</table></div>';
  // 강좌별 인원
  h += '<div class="small" style="margin-top:10px">강좌별 응답자: ';
  h += lectures.map(l => l.symbol + ' ' + (d.lectureCounts[l.id] || 0)).join(' / ');
  h += '</div></div>';
  return h;
}

function renderQ234(d) {
  let h = '<div class="card"><h3>📋 문항 1~4 응답 분포</h3>';
  h += '<div class="group"><h4>2. 임신 여부</h4><table><tr>';
  for (const k of [1,2,3,4]) h += '<th>'+Q2_LABELS[k]+'</th>';
  h += '</tr><tr>';
  for (const k of [1,2,3,4]) h += '<td>'+(d.q2Counts[k]||0)+'명</td>';
  h += '</tr></table></div>';
  h += '<div class="group"><h4>3. 교육 신청 경로 (중복선택)</h4><table><tr>';
  for (const k of [1,2,3,4]) h += '<th>'+Q3_LABELS[k]+'</th>';
  h += '</tr><tr>';
  for (const k of [1,2,3,4]) h += '<td>'+(d.q3Counts[k]||0)+'명</td>';
  h += '</tr></table>';
  if (d.q3EtcList.length) {
    h += '<div class="small" style="margin-top:6px"><b>기타 응답:</b> '+d.q3EtcList.map(e=>escHtml(e.text)).join(' / ')+'</div>';
  }
  h += '</div>';
  h += '<div class="group"><h4>4. 신청 이유 (중복선택)</h4><table><tr>';
  for (const k of [1,2,3,4]) h += '<th>'+Q4_LABELS[k]+'</th>';
  h += '</tr><tr>';
  for (const k of [1,2,3,4]) h += '<td>'+(d.q4Counts[k]||0)+'명</td>';
  h += '</tr></table></div>';
  h += '</div>';
  return h;
}

// ===== 강좌 관리 =====
function renderLectureManagement() {
  const list = S.allLectures || [];
  let h = '<div class="card"><h3>🎓 강좌 관리</h3>';
  h += '<div class="small" style="margin-bottom:14px">활성화된 강좌만 설문 페이지에 노출됩니다. 응답이 있는 강좌는 삭제할 수 없으니 비활성화를 사용해주세요.</div>';
  h += '<table style="margin-bottom:18px"><tr><th>ID</th><th>강좌명</th><th>활성</th><th>응답수</th><th>관리</th></tr>';
  for (const l of list) {
    h += '<tr>'+
      '<td>'+l.id+'</td>'+
      '<td class="l"><input type="text" value="'+escHtml(l.name||'')+'" id="lec-name-'+l.id+'" style="width:100%;padding:4px 8px;border:1px solid var(--bd);border-radius:4px"></td>'+
      '<td><label style="cursor:pointer"><input type="checkbox" '+(l.active?'checked':'')+' onchange="toggleLectureActive('+l.id+',this.checked)"> '+(l.active?'활성':'비활성')+'</label></td>'+
      '<td>'+(l.response_count||0)+'</td>'+
      '<td>'+
        '<button onclick="saveLecture('+l.id+')" style="padding:4px 8px;border:1px solid var(--p);color:var(--p);background:#fff;border-radius:4px;font-size:12px;cursor:pointer;margin-right:4px">저장</button>'+
        (l.response_count > 0 ? '<button disabled style="padding:4px 8px;border:1px solid #ddd;color:#bbb;background:#fafafa;border-radius:4px;font-size:12px;cursor:not-allowed" title="응답이 있어 삭제 불가">삭제</button>' :
        '<button onclick="deleteLecture('+l.id+')" style="padding:4px 8px;border:1px solid #c33;color:#c33;background:#fff;border-radius:4px;font-size:12px;cursor:pointer">삭제</button>')+
      '</td>'+
    '</tr>';
  }
  h += '</table>';
  // 추가 폼
  h += '<div style="border-top:2px dashed var(--bd);padding-top:14px;margin-top:14px"><h4 style="color:var(--p);margin:0 0 10px">+ 새 강좌 추가</h4>';
  h += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  h += '<input type="text" id="new-lec-name" placeholder="강좌명" style="flex:1;min-width:240px;padding:8px;border:1px solid var(--bd);border-radius:4px">';
  h += '<label style="display:flex;align-items:center;gap:4px;font-size:13px"><input type="checkbox" id="new-lec-active" checked> 활성화</label>';
  h += '<button onclick="addLecture()" style="padding:8px 16px;background:var(--p);color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600">추가</button>';
  h += '</div></div></div>';
  return h;
}

window.toggleLectureActive = async (id, active) => {
  try {
    await authedFetchJson('/api/admin/lectures/' + id, { method: 'PATCH', body: { active } });
    await loadAllLectures();
    render();
  } catch (e) { alert('변경 실패: ' + e.message); }
};
window.saveLecture = async (id) => {
  const name = document.getElementById('lec-name-' + id).value.trim();
  if (!name) { alert('강좌명은 비워둘 수 없습니다'); return; }
  try {
    await authedFetchJson('/api/admin/lectures/' + id, { method: 'PATCH', body: { name } });
    await loadAllLectures();
    render();
    alert('저장되었습니다');
  } catch (e) { alert('저장 실패: ' + e.message); }
};
window.deleteLecture = async (id) => {
  if (!confirm('정말 삭제하시겠습니까?')) return;
  try {
    await authedFetchJson('/api/admin/lectures/' + id, { method: 'DELETE' });
    await loadAllLectures();
    render();
  } catch (e) { alert('삭제 실패: ' + e.message); }
};
window.addLecture = async () => {
  const name = document.getElementById('new-lec-name').value.trim();
  const active = document.getElementById('new-lec-active').checked;
  if (!name) { alert('강좌명을 입력해주세요'); return; }
  try {
    await authedFetchJson('/api/admin/lectures', { method: 'POST', body: { name, active } });
    await loadAllLectures();
    render();
  } catch (e) { alert('추가 실패: ' + e.message); }
};

async function authedFetchJson(path, opts) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + S.pwd, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

// ===== 설문 편집 =====
function renderSurveyEdit() {
  const c = S.configEdit || {};
  const safeOpts = (a) => Array.isArray(a) ? a : ['','','',''];
  const inp = (id, val, ph) => '<input type="text" id="'+id+'" value="'+escHtml(val||'')+'" placeholder="'+(ph||'')+'" style="width:100%;padding:8px;border:1px solid var(--bd);border-radius:4px;font-size:14px">';
  let h = '<div class="card"><h3>📝 설문 편집</h3>';
  h += '<div class="small" style="margin-bottom:14px">문항 텍스트와 보기 텍스트를 변경할 수 있습니다. 보기 개수와 문항 구조는 변경할 수 없으며 변경 시 누적된 응답 통계는 새 라벨로 표시됩니다.</div>';
  // 전체
  h += '<div class="group"><h4>전체</h4>';
  h += '<div style="margin-bottom:8px">앱 타이틀'+inp('cfg-appTitle', c.appTitle)+'</div>';
  h += '<div>병원명 (브랜드 라인)'+inp('cfg-brandLine', c.brandLine)+'</div>';
  h += '</div>';
  // Q1
  h += '<div class="group"><h4>1번 문항 (강좌 선택)</h4>';
  h += '<div>제목'+inp('cfg-q1-title', c.q1 && c.q1.title)+'</div>';
  h += '<div class="small" style="margin-top:6px">강좌 보기는 강좌 관리 탭에서 추가/수정합니다.</div>';
  h += '</div>';
  // Q2
  const q2o = safeOpts(c.q2 && c.q2.options);
  h += '<div class="group"><h4>2번 문항</h4>';
  h += '<div>제목'+inp('cfg-q2-title', c.q2 && c.q2.title)+'</div>';
  for (let i = 0; i < 4; i++) h += '<div style="margin-top:6px">보기 '+(i+1)+inp('cfg-q2-opt-'+i, q2o[i])+'</div>';
  h += '</div>';
  // Q3
  const q3o = safeOpts(c.q3 && c.q3.options);
  h += '<div class="group"><h4>3번 문항 (중복선택)</h4>';
  h += '<div>제목'+inp('cfg-q3-title', c.q3 && c.q3.title)+'</div>';
  for (let i = 0; i < 4; i++) h += '<div style="margin-top:6px">보기 '+(i+1)+(i===3?' (기타)':'')+inp('cfg-q3-opt-'+i, q3o[i])+'</div>';
  h += '</div>';
  // Q4
  const q4o = safeOpts(c.q4 && c.q4.options);
  h += '<div class="group"><h4>4번 문항 (중복선택)</h4>';
  h += '<div>제목'+inp('cfg-q4-title', c.q4 && c.q4.title)+'</div>';
  for (let i = 0; i < 4; i++) h += '<div style="margin-top:6px">보기 '+(i+1)+inp('cfg-q4-opt-'+i, q4o[i])+'</div>';
  h += '</div>';
  // Q5-9
  const q59 = (c.q5_9 && Array.isArray(c.q5_9.titles)) ? c.q5_9.titles : ['','','','',''];
  h += '<div class="group"><h4>5~9번 문항 (만족도 5점 척도, 보통이다=3 / 그렇다=4 / 매우그렇다=5)</h4>';
  for (let i = 0; i < 5; i++) h += '<div style="margin-top:6px">'+(5+i)+'번 제목'+inp('cfg-q59-'+i, q59[i])+'</div>';
  h += '</div>';
  // Q10
  h += '<div class="group"><h4>10번 문항 (자유 서술)</h4>';
  h += '<div>제목'+inp('cfg-q10-title', c.q10 && c.q10.title)+'</div>';
  h += '</div>';
  // 저장 버튼
  h += '<div style="text-align:right;margin-top:12px">';
  h += '<button onclick="resetSurveyConfig()" style="padding:8px 14px;border:1px solid var(--bd);background:#fff;border-radius:4px;margin-right:6px;cursor:pointer">기본값으로 되돌리기</button>';
  h += '<button onclick="saveSurveyConfig()" style="padding:8px 16px;background:var(--p);color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:600">저장</button>';
  h += '</div>';
  h += '</div>';
  return h;
}

window.saveSurveyConfig = async () => {
  const v = (id) => document.getElementById(id).value;
  const cfg = {
    appTitle: v('cfg-appTitle'),
    brandLine: v('cfg-brandLine'),
    q1: { title: v('cfg-q1-title') },
    q2: { title: v('cfg-q2-title'), options: [v('cfg-q2-opt-0'),v('cfg-q2-opt-1'),v('cfg-q2-opt-2'),v('cfg-q2-opt-3')] },
    q3: { title: v('cfg-q3-title'), options: [v('cfg-q3-opt-0'),v('cfg-q3-opt-1'),v('cfg-q3-opt-2'),v('cfg-q3-opt-3')] },
    q4: { title: v('cfg-q4-title'), options: [v('cfg-q4-opt-0'),v('cfg-q4-opt-1'),v('cfg-q4-opt-2'),v('cfg-q4-opt-3')] },
    q5_9: { titles: [v('cfg-q59-0'),v('cfg-q59-1'),v('cfg-q59-2'),v('cfg-q59-3'),v('cfg-q59-4')] },
    q10: { title: v('cfg-q10-title') },
  };
  for (const arr of [cfg.q2.options, cfg.q3.options, cfg.q4.options]) {
    if (arr.some(s => !s.trim())) { alert('모든 보기는 비워둘 수 없습니다'); return; }
  }
  if (cfg.q5_9.titles.some(s => !s.trim())) { alert('5~9번 문항 제목을 모두 입력해주세요'); return; }
  try {
    await authedFetchJson('/api/admin/survey-config', { method: 'PUT', body: { config: cfg } });
    applyConfigLabels(cfg);
    SURVEY_CFG = cfg;
    S.configEdit = JSON.parse(JSON.stringify(cfg));
    alert('설문 설정이 저장되었습니다');
  } catch (e) { alert('저장 실패: ' + e.message); }
};

window.resetSurveyConfig = () => {
  if (!confirm('기본값으로 되돌리시겠습니까? (저장 전까지는 적용되지 않습니다)')) return;
  S.configEdit = {
    appTitle: '강남차 여성병원 건강강좌 프로그램 만족도 조사',
    brandLine: '강남차 여성병원',
    q1: { title: '수강한 교육명을 체크해주세요' },
    q2: { title: '현재 임신 중이신가요?', options: ['첫째','둘째','셋째 이상','해당없음'] },
    q3: { title: '교육을 어떻게 알고 신청하셨나요?(중복선택 가능)', options: ['병원 직원의 안내','온라인에서 정보 습득 (홈페이지, 블로그 등)','지인 추천','기타'] },
    q4: { title: '교육을 신청한 이유는 무엇입니까?(중복선택 가능)', options: ['임신 및 출산에 도움','평소 관심 있는 주제','가족 및 지인 추천','강남차병원 교육의 신뢰'] },
    q5_9: { titles: ['교육 진행시간은 적절한가요?','교육 내용을 이해하기 쉽게 설명하였나요?','궁금증 해소에 도움이 되었나요?','교육의 만족도 및 타인 추천할 마음은?','교육 장소와 시설은 어떠했나요?'] },
    q10: { title: '교육을 통해 느낀 소감, 강의 개선 점, 향후 듣고 싶은 교육이 있다면 작성해주세요' },
  };
  render();
};

function renderComments(d) {
  if (!d.comments.length) return '<div class="card"><h3>💬 자유 서술</h3><div class="small">의견이 없습니다.</div></div>';
  const byLec = {};
  for (const c of d.comments) {
    if (!byLec[c.lecture_id]) byLec[c.lecture_id] = { name: c.lecture_name, items: [] };
    byLec[c.lecture_id].items.push(c);
  }
  let h = '<div class="card"><h3>💬 자유 서술 ('+d.comments.length+'개)</h3>';
  for (const lid of Object.keys(byLec)) {
    const g = byLec[lid];
    h += '<div class="group"><h4>'+escHtml(g.name)+' ('+g.items.length+')</h4>';
    for (const c of g.items) {
      h += '<div class="comment"><div class="meta">'+c.year+'-'+String(c.month).padStart(2,'0')+'-'+String(c.day).padStart(2,'0')+'</div>'+escHtml(c.text)+'</div>';
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// init
async function init() {
  if (S.pwd) {
    try {
      const d = await authedFetch('/api/admin/months');
      S.authed = true;
      S.availableMonths = d.months || [];
      if (S.availableMonths.length) {
        S.year = S.availableMonths[0].year;
        S.month = S.availableMonths[0].month;
        S.quarter = Math.ceil(S.month / 3);
      }
      await loadConfig();
      await loadLectures();
      await reload();
    } catch {
      S.authed = false; render();
    }
  } else {
    render();
  }
}
init();
</script>
</body>
</html>`;

// ============================================================================
// 라우터
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: { ...CORS_HEADERS, "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" } });
    }

    try {
      // PWA 자산
      if (path === "/manifest.webmanifest") return manifestResponse();
      // 아이콘 PNG는 dist/ 정적 파일로 직접 서빙 (env.ASSETS 사용)
      if (/^\/icon-(\d+)\.png$/.test(path) && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      // 페이지
      if (path === "/" || path === "/survey") return html(SURVEY_HTML);
      if (path === "/admin" || path === "/admin/") return html(ADMIN_HTML);
      if (path === "/qr" || path === "/qr/") return html(QR_HTML);

      // 공개 API
      if (path === "/api/lectures" && method === "GET") return apiLectures(env);
      if (path === "/api/survey-config" && method === "GET") return apiSurveyConfig(env);
      if (path === "/api/responses" && method === "POST")
        return apiPostResponse(request, env);

      // 관리자 API
      if (path.startsWith("/api/admin/")) {
        const err = await checkAdmin(request, env);
        if (err) return err;
        if (path === "/api/admin/stats" && method === "GET")
          return apiAdminStats(request, env);
        if (path === "/api/admin/months" && method === "GET")
          return apiAdminAvailableMonths(env);
        if (path === "/api/admin/sessions" && method === "GET")
          return apiAdminLectureSessions(env);
        if (path === "/api/admin/change-password" && method === "POST")
          return apiAdminChangePassword(request, env);
        if (path === "/api/admin/survey-config" && method === "PUT")
          return apiAdminUpdateSurveyConfig(request, env);
        if (path === "/api/admin/lectures" && method === "GET")
          return apiAdminListLectures(env);
        if (path === "/api/admin/lectures" && method === "POST")
          return apiAdminCreateLecture(request, env);
        const lectureMatch = path.match(/^\/api\/admin\/lectures\/(\d+)$/);
        if (lectureMatch) {
          const lid = parseInt(lectureMatch[1], 10);
          if (method === "PATCH" || method === "PUT")
            return apiAdminUpdateLecture(request, env, lid);
          if (method === "DELETE") return apiAdminDeleteLecture(env, lid);
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};
