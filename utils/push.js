/**
 * Expo Push Notifications 발송 유틸
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPushNotification({ to, title, body, data = {}, sound = 'default' }) {
  if (!to) {
    console.warn('[Push] push_token이 없어서 발송 스킵');
    return { skipped: true, reason: 'no_token' };
  }

  if (!to.startsWith('ExponentPushToken[') && !to.startsWith('ExpoPushToken[')) {
    console.warn(`[Push] 유효하지 않은 토큰 형식: ${to}`);
    return { skipped: true, reason: 'invalid_token' };
  }

  const message = {
    to,
    title,
    body,
    data,
    sound,
    priority: 'high',
    channelId: 'default',
  };

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();
    console.log(`[Push] ✅ 발송 완료 - "${title}" → ${to.slice(0, 30)}...`);

    if (result?.data?.status === 'error') {
      console.error('[Push] ❌ Expo 에러:', result.data);
    }

    return result;
  } catch (err) {
    console.error('[Push] ❌ 발송 실패:', err.message);
    return { error: err.message };
  }
}

async function sendPushToUser(db, userId, payload) {
  try {
    const result = await db.query(
      'SELECT push_token FROM users WHERE id = $1',
      [userId]
    );

    const token = result.rows[0]?.push_token;
    if (!token) {
      console.warn(`[Push] user_id=${userId}의 push_token이 없음`);
      return { skipped: true, reason: 'no_token_in_db' };
    }

    return await sendPushNotification({ to: token, ...payload });
  } catch (err) {
    console.error('[Push] sendPushToUser 실패:', err);
    return { error: err.message };
  }
}

module.exports = {
  sendPushNotification,
  sendPushToUser,
};