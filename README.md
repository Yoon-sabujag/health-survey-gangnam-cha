# 강남차 여성병원 건강강좌 만족도 조사

매월 9개 건강강좌 만족도 조사를 자동화하기 위한 시스템.
Cloudflare Pages + D1으로 운영.

## URL

- 설문 (수강자용 QR 연결): https://health-survey-gangnam-cha.pages.dev
- QR 표시 (강의자 빔프로젝터용): https://health-survey-gangnam-cha.pages.dev/qr
- 관리자: https://health-survey-gangnam-cha.pages.dev/admin

## 구성

- `src/index.js` — Worker 본체 (HTML + API + D1 쿼리)
- `wrangler.toml` — Cloudflare Pages 배포 설정
- `dist/_worker.js` — 빌드 산출물 (자동 생성)

## 운영

```bash
npm install
npm run deploy   # Pages 배포
```

## 환경 변수 (Cloudflare Pages 대시보드에서 설정)

- `MASTER_PASSWORD` — 관리자 마스터 비밀번호 (분실 시 복구용)

## 인증

관리자 비밀번호는 D1 `settings.admin_password_hash`에 SHA-256 해시로 저장.
관리자 페이지의 비밀번호 변경 버튼으로 수정.
환경 변수 `MASTER_PASSWORD`는 항상 통과되는 마스터 비밀번호.
