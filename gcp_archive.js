const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const stream = require('stream');
const zlib = require('zlib');

const oauth2Client = new google.auth.OAuth2(
  process.env.GCP_CLIENT_ID,
  process.env.GCP_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: process.env.GCP_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

const ROOT_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const BATCH_SIZE = 10;
const MAX_RETRIES = 5;

// ★ [재설계] 여러 개의 API 키를 쉼표(,) 기준으로 쪼개서 배열(탄창)로 만듭니다.
const apiKeys = (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(k => k.length > 0);

const delay = ms => new Promise(res => setTimeout(res, ms));

async function getOrCreateFolder(folderName, parentId) {
  try {
    const res = await drive.files.list({
      q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
    });
    if (res.data.files.length > 0) return res.data.files[0].id;
    const folder = await drive.files.create({
      resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id',
    });
    return folder.data.id;
  } catch (err) { return parentId; }
}

async function isMermaidValid(code) {
  try {
    const data = Buffer.from(code, 'utf8');
    const compressed = zlib.deflateSync(data);
    const base64 = compressed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const response = await fetch(`https://kroki.io/mermaid/svg/${base64}`);
    return response.ok && !(await response.text()).includes('Syntax error');
  } catch(e) { return false; }
}

async function main() {
  if (apiKeys.length === 0) {
    console.error("❌ API 키가 등록되지 않았습니다.");
    process.exit(1);
  }

  try {
    const gplayModule = await import('google-play-scraper');
    const gplay = gplayModule.default || gplayModule;
    
    // 1. 구글 플레이에서 원본 100개 데이터 추출
    const rawGames = await gplay.list({ collection: gplay.collection.GROSSING, category: gplay.category.GAME, num: 100, country: 'kr', lang: 'ko' });
    
    // ★ [재설계] 배열을 섞기 전에 '실제 매출 순위'를 각 게임 데이터에 영구적으로 각인시킵니다.
    const allGames = rawGames.map((game, index) => ({ ...game, actualRank: index + 1 }));

    const now = new Date();
    now.setHours(now.getHours() + 9);
    const dateString = now.toISOString().split('T')[0];
    const yearStr = String(now.getFullYear());
    const monthStr = String(now.getMonth() + 1).padStart(2, '0') + "월";

    if (allGames.length > 0) {
      const yearId = await getOrCreateFolder(yearStr, ROOT_FOLDER_ID);
      const targetFolderId = await getOrCreateFolder(monthStr, yearId);

      // ★ [재설계] 원본을 보존하기 위해 스프레드 연산자([...])로 복사본을 만들어 섞습니다.
      const targetGames = [...allGames].sort(() => 0.5 - Math.random()).slice(0, BATCH_SIZE);
      
      console.log(`\n[${dateString}] 🗄️ 멀티 API 코어 적재 엔진 가동 (가용 키: ${apiKeys.length}개)`);

      for (let idx = 0; idx < targetGames.length; idx++) {
        const luckyGame = targetGames[idx];
        const luckyRank = luckyGame.actualRank; // 변질되지 않은 진짜 순위 호출
        
        // ★ [재설계] 라운드 로빈 방식으로 API 키를 교대로 사용 (0번->1번->2번->0번...)
        const currentKey = apiKeys[idx % apiKeys.length];
        const genAI = new GoogleGenerativeAI(currentKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        console.log(`\n[${idx + 1}/${BATCH_SIZE}] 매출 ${luckyRank}위: ${luckyGame.title} 처리 중 (API Core ${ (idx % apiKeys.length) + 1 } 사용)`);

        let reportText = "";
        let attempt = 1;

        while (attempt <= MAX_RETRIES) {
          const prompt = `
# Role: Senior Game System Architect
# Task: Logic Analysis for Machine Learning Training
# Target: [${luckyGame.title}]

컴퓨터가 파싱할 데이터이므로 서술적인 문장은 배제하고 구조적 데이터에 집중하십시오.

## [Requirement 1] JSON Metadata Header
문서 최상단에 아래 형식의 JSON 블록을 포함하십시오:
\`\`\`json
{
  "analysis_date": "${dateString}",
  "store_rank": ${luckyRank},
  "game_title": "${luckyGame.title}",
  "developer": "${luckyGame.developer}",
  "core_system_analyzed": "특정 시스템명"
}
\`\`\`

## [Requirement 2] System Specs (Mermaid Focus)
아래 항목을 Mermaid 다이어그램과 함께 상세 명세로 작성하십시오.
- 01. 유저 경험 플로우차트 (Mermaid flowchart TD)
- 02. 시스템 상세 규칙 및 수치 밸런스 로직
- 03. 확장형 데이터 테이블 설계 및 ERD (Mermaid erDiagram)
- 04. 예외 처리 및 어뷰징 방어 기제

${attempt > 1 ? "주의: 이전 시도에서 Mermaid 문법 에러가 났습니다. Syntax를 엄격히 교정하십시오." : ""}
`;
          const result = await model.generateContent(prompt);
          reportText = result.response.text();

          const mermaidMatches = reportText.match(/```mermaid\n([\s\S]*?)\n```/g) || [];
          let allValid = true;
          for (const m of mermaidMatches) {
            const code = m.replace(/```mermaid\n/, '').replace(/\n```/, '');
            if (!(await isMermaidValid(code))) { allValid = false; break; }
          }
          if (allValid) break;
          else { attempt++; await delay(10000); }
        }

        const fileName = `[${dateString}]_${String(luckyRank).padStart(3, '0')}위_${luckyGame.title.replace(/[/\\?%*:|"<>]/g, '_')}.md`;
        const bufferStream = new stream.PassThrough();
        bufferStream.end(Buffer.from(reportText, 'utf8'));

        try {
          await drive.files.create({
            requestBody: { name: fileName, parents: [targetFolderId] },
            media: { mimeType: 'text/markdown', body: bufferStream }
          });
          console.log(`  -> 💾 적재 완료: ${yearStr}/${monthStr}/${fileName}`);
        } catch (e) { console.error(`  -> ❌ 실패: ${e.message}`); }

        // 키를 여러 개 쓰므로 과부하 위험이 줄었지만, 안전 마진을 위해 20초 쿨타임 유지
        if (idx < targetGames.length - 1) await delay(20000); 
      }
    }
  } catch (error) { console.error("공정 에러:", error); process.exit(1); }
}
main();
