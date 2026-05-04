/**
 * Firebase Admin SDK 초기화 + ID Token 검증 유틸
 * 
 * 사용처: routes/auth.js, 기타 보호된 라우트
 */

const admin = require('firebase-admin');
const path = require('path');

let initialized = false;

/**
 * Firebase Admin 초기화
 * - 로컬: firebase-service-account.json 파일 사용
 * - Railway/Production: FIREBASE_SERVICE_ACCOUNT 환경변수(JSON 문자열) 사용
 */
function initFirebaseAdmin() {
  if (initialized) return admin;

  try {
    let serviceAccount;

    // 1. 환경변수 우선 (Railway 배포)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.log('[Firebase Admin] 환경변수에서 서비스 계정 로드');
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    // 2. 로컬 파일 fallback (개발 환경)
    else {
      const filePath = path.join(__dirname, '..', 'firebase-service-account.json');
      console.log('[Firebase Admin] 로컬 파일에서 서비스 계정 로드:', filePath);
      serviceAccount = require(filePath);
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    initialized = true;
    console.log('[Firebase Admin] 초기화 완료, project:', serviceAccount.project_id);
    return admin;
  } catch (error) {
    console.error('[Firebase Admin] 초기화 실패:', error.message);
    throw error;
  }
}

/**
 * Firebase ID Token 검증
 * 
 * @param {string} idToken - 클라이언트에서 보낸 ID Token
 * @returns {Promise<DecodedIdToken>} - 검증된 토큰 정보 (uid, phone_number 등)
 * @throws {Error} - 토큰이 유효하지 않을 때
 */
async function verifyIdToken(idToken) {
  if (!initialized) initFirebaseAdmin();
  
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log('[Firebase Admin] 토큰 검증 성공, UID:', decoded.uid);
    return decoded;
  } catch (error) {
    console.error('[Firebase Admin] 토큰 검증 실패:', error.code, error.message);
    throw new Error('INVALID_FIREBASE_TOKEN');
  }
}

/**
 * 미들웨어: Authorization 헤더에서 토큰 검증
 * 
 * 사용 예:
 *   router.get('/protected', authMiddleware, (req, res) => {
 *     // req.firebaseUser.uid 로 접근
 *   });
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'NO_TOKEN',
      message: '인증 토큰이 필요합니다.' 
    });
  }

  try {
    const decoded = await verifyIdToken(token);
    req.firebaseUser = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ 
      success: false, 
      error: 'INVALID_TOKEN',
      message: '유효하지 않은 토큰입니다.' 
    });
  }
}

module.exports = {
  initFirebaseAdmin,
  verifyIdToken,
  authMiddleware,
};