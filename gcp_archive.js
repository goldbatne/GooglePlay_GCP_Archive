const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const stream = require('stream');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 구글 드라이브 인증 세팅 (GitHub Secret의 줄바꿈 문자열 복구 로직 포함)
const auth = new google.auth.JWT(
  process.env.GCP_CLIENT_EMAIL,
  null,
  (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/drive.file']
);
const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const BATCH_SIZE = 10; // 무작위 10개 추출

const delay = ms => new Promise(res => setTimeout(res, ms));

async function main() {
  try {
    const gplayModule = await import('google-play-scraper');
    const gplay = gplayModule.default || gplayModule;
    
    const games = await gplay.list({ collection: gplay.collection.GROSSING, category: gplay.category.GAME, num: 100, country: 'kr', lang: 'ko' });
    const today = new Date();
    today.setHours(today.getHours() + 9);
    const dateString = today.toISOString().split('T')[0];

    if (games.length > 0) {
      const gamesWithRank = games.map((g, index) => ({ ...g, originalRank: index + 1 }));
      const shuffledGames = gamesWithRank.sort(() => 0.5 - Math.random());
      const targetGames = shuffledGames.slice(0, BATCH_SIZE);

      console.log(`\n[${dateString}] 🗄️ 로컬 LLM 학습용 Data Lake 적재 파이프라인 가동 (목표: ${BATCH_SIZE}개 파일)`);

      for (let idx = 0; idx < targetGames.length; idx++) {
        const luckyGame = targetGames[idx];
        const targetGame = luckyGame.title;
        const developer = luckyGame.developer || '미상';
        const luckyRank = luckyGame.originalRank;
        
        console.log(`\n[${idx + 1}/${BATCH_SIZE}] 매출 ${luckyRank}위: ${targetGame} 텍스트 추출 중...`);

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools: [{ googleSearch: {} }] });
        
        const prompt = `
# Role
당신은 15년 차 수석 게임 시스템 기획자이자 실무 디렉터입니다.

# Input
* **타겟 게임:** [${developer}]의 ${targetGame} (구글 매출 ${luckyRank}위)

# Step 0: 메타데이터 정의
본문 작성 전 최상단에 반드시 다음 1줄을 작성하십시오.
시스템: (15자 이내 명사형)

# Step 1 & 2: 입체 역기획서 작성
해당 게임의 핵심 시스템 1개를 특정하여, 아래 8단계 구조에 맞춰 마크다운 형식으로 작성하십시오. 로컬 LLM이 구조를 파악할 수 있도록 다이어그램(Mermaid) 작성 시 가장 복잡하고 정교한 수준으로 로직을 짜십시오.
01. 시스템 정의 및 ROI
02. 콘텐츠 코어 루프 (Mermaid graph LR)
03. 레벨 디자인 및 난이도 곡선 (Mermaid flowchart TD)
04. 수치 밸런스 설계 로직
05. 상세 명세 및 동기 설계
06. 확장형 데이터 테이블 (Mermaid erDiagram)
07. 예외 처리 및 방어 기제
08. 비즈니스 통찰 및 개발 코스트
`;
        
        // 시각화(렌더링) QA 없이 다이렉트로 텍스트를 뽑아냅니다.
        const result = await model.generateContent(prompt);
        let reportText = result.response.text();
        
        let parsedSystem = "핵심시스템";
        const systemMatch = reportText.match(/시스템:\s*([^\n]+)/);
        if (systemMatch) parsedSystem = systemMatch[1].replace(/\[\/META\]/gi, '').trim().replace(/[/\\?%*:|"<>]/g, ''); 

        reportText = reportText.replace(/시스템:.*?\n/g, '').trim();
        const finalMarkdown = `# [${dateString}] ${targetGame} 역기획서\n- 매출 순위: ${luckyRank}위\n- 분석 시스템: ${parsedSystem}\n\n${reportText}`;

        // 파일명 특수문자 제거 및 3자리 랭킹 패딩(001위, 012위) 적용
        const safeTitle = targetGame.replace(/[/\\?%*:|"<>]/g, '_');
        const fileName = `[${dateString}]_${String(luckyRank).padStart(3, '0')}위_${safeTitle}_${parsedSystem}.md`;
        
        const bufferStream = new stream.PassThrough();
        bufferStream.end(Buffer.from(finalMarkdown, 'utf8'));

        try {
          await drive.files.create({
            requestBody: { name: fileName, parents: [FOLDER_ID] },
            media: { mimeType: 'text/markdown', body: bufferStream },
            fields: 'id'
          });
          console.log(`  -> 💾 구글 드라이브 업로드 완료: ${fileName}`);
        } catch (uploadError) {
          console.error(`  -> ❌ 업로드 실패 (${fileName}):`, uploadError.message);
        }

        // 구글 API 호출 한도(Rate Limit) 방어를 위한 필수 쿨타임 (15초)
        if (idx < targetGames.length - 1) {
          await delay(15000); 
        }
      } 
      console.log(`\n[${dateString}] 🎉 10개 마크다운 파일 구글 드라이브 분리 적재 완료.`);
    }
  } catch (error) { console.error("실행 중 에러 발생:", error); process.exit(1); }
}
main();
