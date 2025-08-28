const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Завантаження конфігурації
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Ініціалізація Telegram бота
const bot = new TelegramBot(config.telegram.botToken, { polling: true });

// Обробник повідомлень для отримання Chat ID
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Автоматично оновлюємо Chat ID в конфігурації
  config.telegram.chatId = chatId.toString();
  
  // Зберігаємо оновлену конфігурацію
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`❌ Помилка збереження Chat ID:`, error.message);
  }
  
  // Обробляємо команди
  if (text === '📊 Статус користувачів') {
    showStatus(chatId);
  } else if (text === '🔄 Ручна перевірка') {
    await runManualCheck(chatId);
  } else {
    // Для будь-якого іншого повідомлення показуємо головне меню
    showMainMenu(chatId);
  }
});

// Обробка помилок polling
bot.on('polling_error', (error) => {
  console.error('❌ Помилка polling Telegram бота:', error.message);
  
  // Спробуємо перезапустити polling через 5 секунд
  setTimeout(() => {
    bot.stopPolling().then(() => {
      setTimeout(() => {
        bot.startPolling().catch(err => {
          console.error('❌ Помилка перезапуску polling:', err.message);
        });
      }, 1000);
    }).catch(err => {
      console.error('❌ Помилка зупинки polling:', err.message);
    });
  }, 5000);
});

// При запуску бота автоматично показуємо меню
bot.on('polling_start', () => {
  if (config.telegram.chatId && config.telegram.chatId !== 'YOUR_CHAT_ID') {
    showMainMenu(config.telegram.chatId);
  }
});

bot.on('polling_stop', () => {
  // Без логування
});

// Функція для показу головного меню
function showMainMenu(chatId) {
  const welcomeMessage = `🎵 Last.fm Монітор

📊 Моніторимо ${config.users.length} користувачів:
${config.users.map(user => `• ${user.username}`).join('\n')}

⏰ Автоматична перевірка: кожні 5 хвилин
⏱️ Поріг неактивності: ${config.inactivityThreshold.minutes} хвилин`;

  const keyboard = {
    keyboard: [
      ['📊 Статус користувачів', '🔄 Ручна перевірка']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };

  bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
}

// Функція для показу статусу
function showStatus(chatId) {
  let statusMessage = `📊 Статус користувачів:\n\n`;
  
  for (const user of config.users) {
    const userState = userStates.get(user.username);
    const status = userState === 'active' ? '✅ Активний' : '❌ Неактивний';
    statusMessage += `${user.username}: ${status}\n`;
  }
  
  const keyboard = {
    keyboard: [
      ['📊 Статус користувачів', '🔄 Ручна перевірка']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
  
  bot.sendMessage(chatId, statusMessage, { reply_markup: keyboard });
}

// Функція для ручної перевірки
async function runManualCheck(chatId) {
  await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
  await checkAllUsers();
  await bot.sendMessage(chatId, '✅ Перевірка завершена!');
}





// Зберігання стану користувачів (активний/неактивний)
const userStates = new Map();

// Функція для отримання останнього треку з Last.fm API
async function getLastTrack(username) {
  try {
    const response = await axios.get('http://ws.audioscrobbler.com/2.0/', {
      params: {
        method: 'user.getrecenttracks',
        user: username,
        api_key: config.lastfm.apiKey,
        format: 'json',
        limit: 1
      },
      timeout: 10000 // 10 секунд таймаут
    });

    // Перевіряємо структуру відповіді
    if (!response.data || !response.data.recenttracks || !response.data.recenttracks.track) {
      return null;
    }

    const tracks = response.data.recenttracks.track;
    
    // Якщо tracks - масив
    if (Array.isArray(tracks) && tracks.length > 0) {
      const lastTrack = tracks[0];
      return processTrackData(lastTrack, username);
    }
    
    // Якщо tracks - об'єкт (один трек)
    if (tracks && typeof tracks === 'object') {
      return processTrackData(tracks, username);
    }
    
    return null;
    
  } catch (error) {
    return null;
  }
}

// Допоміжна функція для обробки даних треку
function processTrackData(track, username) {
  try {
    // Перевіряємо чи трек зараз грає
    const isNowPlaying = track['@attr'] && track['@attr'].nowplaying === 'true';
    
    if (isNowPlaying) {
      return {
        timestamp: Math.floor(Date.now() / 1000),
        track: track.name || 'Невідомий трек',
        artist: track.artist && track.artist['#text'] ? track.artist['#text'] : 'Невідомий виконавець',
        isNowPlaying: true
      };
    }
    
    // Якщо трек не грає зараз, використовуємо час останнього прослуханого треку
    if (!track.date || !track.date.uts) {
      return {
        timestamp: Math.floor(Date.now() / 1000),
        track: track.name || 'Невідомий трек',
        artist: track.artist && track.artist['#text'] ? track.artist['#text'] : 'Невідомий виконавець',
        isNowPlaying: false
      };
    }
    
    const timestamp = parseInt(track.date.uts);
    
    // Перевіряємо чи timestamp валідний
    if (isNaN(timestamp) || timestamp < 1000000000) {
      // Якщо timestamp невалідний, використовуємо поточний час
      return {
        timestamp: Math.floor(Date.now() / 1000),
        track: track.name || 'Невідомий трек',
        artist: track.artist && track.artist['#text'] ? track.artist['#text'] : 'Невідомий виконавець',
        isNowPlaying: false
      };
    }
    
    return {
      timestamp: timestamp,
      track: track.name || 'Невідомий трек',
      artist: track.artist && track.artist['#text'] ? track.artist['#text'] : 'Невідомий виконавець',
      isNowPlaying: false
    };
  } catch (error) {
    return null;
  }
}

// Функція для перевірки активності користувача
async function checkUserActivity(user) {
  const username = user.username;
  const lastfmUsername = user.lastfmProfile.split('/').pop(); // Отримуємо username з URL
  
  try {
    const lastTrackData = await getLastTrack(lastfmUsername);
    
    if (!lastTrackData) {
      // Якщо не можемо отримати дані, вважаємо користувача неактивним
      const wasPreviouslyActive = userStates.get(username) === 'active';
      userStates.set(username, 'inactive');
      
      // Повідомляємо про проблему з профілем тільки якщо користувач був активним
      if (wasPreviouslyActive) {
        const message = `⚠️ Проблема з Last.fm профілем!\n\n` +
                       `👤 Користувач: ${username}\n` +
                       `🔗 Профіль: ${user.lastfmProfile}\n` +
                       `❌ Не вдалося отримати дані про активність`;
        
        try {
          if (config.telegram.chatId !== 'YOUR_CHAT_ID') {
            await bot.sendMessage(config.telegram.chatId, message);
          }
        } catch (error) {
          console.error(`❌ Помилка відправки повідомлення для ${username}:`, error.message);
        }
      }
      
      // Встановлюємо прапорець ініціалізації
      if (!userStates.get(username + '_initialized')) {
        userStates.set(username + '_initialized', true);
      }
      return;
    }
    
    // Якщо користувач зараз слухає музику, він точно активний
    if (lastTrackData.isNowPlaying) {
      userStates.set(username, 'active');
      userStates.set(username + '_initialized', true);
      return;
    }
    
    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceLastTrack = currentTime - lastTrackData.timestamp;
    const thresholdMinutes = config.inactivityThreshold.minutes;
    const thresholdSeconds = thresholdMinutes * 60;
    
    const isCurrentlyInactive = timeSinceLastTrack > thresholdSeconds;
    
    // Оновлюємо стан користувача
    userStates.set(username, isCurrentlyInactive ? 'inactive' : 'active');
    
    // Якщо профіль неактивний більше порогу - відправляємо повідомлення
    if (isCurrentlyInactive) {
      const minutesInactive = Math.floor(timeSinceLastTrack / 60);
      const hoursInactive = Math.floor(minutesInactive / 60);
      const daysInactive = Math.floor(hoursInactive / 24);
      
      let timeMessage = '';
      if (daysInactive > 0) {
        timeMessage = `${daysInactive} днів ${hoursInactive % 24} годин`;
      } else if (hoursInactive > 0) {
        timeMessage = `${hoursInactive} годин ${minutesInactive % 60} хвилин`;
      } else {
        timeMessage = `${minutesInactive} хвилин`;
      }
      
      const message = `⚠️ Неактивний Last.fm профіль!\n\n` +
                     `👤 Користувач: ${username}\n` +
                     `⏰ Неактивний: ${timeMessage}\n` +
                     `🔗 Профіль: ${user.lastfmProfile}`;
      
      try {
        if (config.telegram.chatId !== 'YOUR_CHAT_ID') {
          await bot.sendMessage(config.telegram.chatId, message);
        }
      } catch (error) {
        console.error(`❌ Помилка відправки повідомлення для ${username}:`, error.message);
      }
    }
    
    // Встановлюємо прапорець ініціалізації
    if (!userStates.get(username + '_initialized')) {
      userStates.set(username + '_initialized', true);
    }
  } catch (error) {
    console.error(`❌ Помилка перевірки користувача ${username}:`, error.message);
    
    // При помилці вважаємо користувача неактивним
    userStates.set(username, 'inactive');
  }
}

// Функція для перевірки всіх користувачів
async function checkAllUsers() {
  let activeUsers = 0;
  let inactiveUsers = 0;
  let errorUsers = 0;
  
  for (let i = 0; i < config.users.length; i++) {
    const user = config.users[i];
    
    try {
      await checkUserActivity(user);
      
      // Підрахунок статистики
      const userState = userStates.get(user.username);
      if (userState === 'active') {
        activeUsers++;
      } else if (userState === 'inactive') {
        inactiveUsers++;
      } else {
        errorUsers++;
      }
      
    } catch (error) {
      errorUsers++;
    }
    
    // Невелика затримка між запитами до API (крім останнього користувача)
    if (i < config.users.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Налаштування cron-завдання
cron.schedule(config.schedule.cron, () => {
  checkAllUsers().catch(error => {
    console.error('❌ Помилка автоматичної перевірки:', error.message);
  });
});

// Запуск першої перевірки при старті бота
checkAllUsers().catch(error => {
  console.error('❌ Помилка першої перевірки:', error.message);
});

console.log('🤖 Бот запущений і працює!');

// Обробка помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необроблена помилка Promise:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Необроблена помилка:', error.message);
});

// Обробка сигналів завершення
process.on('SIGINT', () => {
  bot.stopPolling().then(() => {
    process.exit(0);
  }).catch(error => {
    console.error('❌ Помилка зупинки бота:', error.message);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  bot.stopPolling().then(() => {
    process.exit(0);
  }).catch(error => {
    console.error('❌ Помилка зупинки бота:', error.message);
    process.exit(1);
  });
}); 