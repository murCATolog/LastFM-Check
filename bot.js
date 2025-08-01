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
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  
  if (msg.text === '/start' || msg.text === '/menu') {
    // Автоматично оновлюємо Chat ID в конфігурації
    config.telegram.chatId = chatId.toString();
    
    // Зберігаємо оновлену конфігурацію
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    
    showMainMenu(chatId);
  } else {
    // Якщо користувач пише щось інше, показуємо привітання з кнопкою START
    sendWelcomeMessage(chatId);
  }
});

// Відправляємо привітання з кнопкою START при першому підключенні
bot.on('polling_error', (error) => {
  console.error('Помилка polling:', error);
});

// Відправляємо привітання з кнопкою START
bot.on('polling_start', () => {
  console.log('🤖 Бот запущений і готовий до роботи!');
});

// Функція для відправки привітання з кнопкою START
function sendWelcomeMessage(chatId) {
  const welcomeMessage = `🎵 Вітаю! Я Last.fm Monitor Bot

Я буду моніторити активність користувачів Last.fm та повідомляти про неактивних.

Натисніть кнопку START щоб почати роботу:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🚀 START', callback_data: 'start_bot' }
      ]
    ]
  };

  bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
}

// Функція для показу головного меню
function showMainMenu(chatId) {
  const welcomeMessage = `🎵 Last.fm Монітор

📊 Моніторимо ${config.users.length} користувачів:
${config.users.map(user => `• ${user.username}`).join('\n')}

⏰ Автоматична перевірка: кожні 10 хвилин
⏱️ Поріг неактивності: ${config.inactivityThreshold.minutes} хвилин`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '📊 Статус користувачів', callback_data: 'status' }
      ]
    ]
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
    inline_keyboard: [
      [
        { text: '📊 Статус знову', callback_data: 'status' },
        { text: '🏠 Головне меню', callback_data: 'main_menu' }
      ]
    ]
  };
  
  bot.sendMessage(chatId, statusMessage, { reply_markup: keyboard });
}

// Функція для ручної перевірки
async function runManualCheck(chatId) {
  bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
  
  try {
    await checkAllUsers();
    bot.sendMessage(chatId, '✅ Перевірка завершена!');
  } catch (error) {
    bot.sendMessage(chatId, '❌ Помилка під час перевірки');
  }
}

// Обробник для inline кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  // Відповідаємо на callback query
  await bot.answerCallbackQuery(query.id);
  
  if (data === 'start_bot') {
    // Автоматично оновлюємо Chat ID в конфігурації
    config.telegram.chatId = chatId.toString();
    
    // Зберігаємо оновлену конфігурацію
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    
    showMainMenu(chatId);
  } else if (data === 'status') {
    showStatus(chatId);
  } else if (data === 'check') {
    await runManualCheck(chatId);
  } else if (data === 'main_menu') {
    showMainMenu(chatId);
  }
});



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
      }
    });

    const tracks = response.data.recenttracks.track;
    if (tracks && tracks.length > 0) {
      const lastTrack = tracks[0];
      
      // Перевіряємо чи трек зараз грає
      const isNowPlaying = lastTrack['@attr'] && lastTrack['@attr'].nowplaying === 'true';
      
      if (isNowPlaying) {
        return {
          timestamp: Math.floor(Date.now() / 1000),
          track: lastTrack.name,
          artist: lastTrack.artist['#text'],
          isNowPlaying: true
        };
      }
      
      // Якщо трек не грає зараз, використовуємо час останнього прослуханого треку
      const timestamp = parseInt(lastTrack.date.uts);
      
      // Перевіряємо чи timestamp валідний
      if (timestamp < 1000000000) {
        console.log(`⚠️ Невалідний timestamp з Last.fm для ${username}: ${timestamp}`);
        console.log(`🔍 Raw date data:`, lastTrack.date);
        
        // Якщо timestamp невалідний, використовуємо поточний час
        return {
          timestamp: Math.floor(Date.now() / 1000),
          track: lastTrack.name,
          artist: lastTrack.artist['#text'],
          isNowPlaying: false
        };
      }
      
      return {
        timestamp: timestamp,
        track: lastTrack.name,
        artist: lastTrack.artist['#text'],
        isNowPlaying: false
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Помилка отримання даних для користувача ${username}:`, error.message);
    return null;
  }
}

// Функція для перевірки активності користувача
async function checkUserActivity(user) {
  const username = user.username;
  const lastfmUsername = user.lastfmProfile.split('/').pop(); // Отримуємо username з URL
  
  const lastTrackData = await getLastTrack(lastfmUsername);
  
  if (!lastTrackData) {
    return;
  }
  
  // Якщо користувач зараз слухає музику, він точно активний
  if (lastTrackData.isNowPlaying) {
    // Оновлюємо стан користувача як активний
    userStates.set(username, 'active');
    return;
  }
  
  const currentTime = Math.floor(Date.now() / 1000);
  const timeSinceLastTrack = currentTime - lastTrackData.timestamp;
  const thresholdMinutes = config.inactivityThreshold.minutes;
  const thresholdSeconds = thresholdMinutes * 60;
  
  const isCurrentlyInactive = timeSinceLastTrack > thresholdSeconds;
  const wasPreviouslyActive = userStates.get(username) === 'active';
  
  // Оновлюємо стан користувача
  userStates.set(username, isCurrentlyInactive ? 'inactive' : 'active');
  
  // Повідомляємо якщо користувач саме став неактивним АБО якщо це перший запуск і він неактивний
  const isFirstRun = userStates.get(username + '_initialized') !== true;
  
  if ((isCurrentlyInactive && wasPreviouslyActive) || (isCurrentlyInactive && isFirstRun)) {
    userStates.set(username + '_initialized', true);
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
      if (config.telegram.chatId === 'YOUR_CHAT_ID') {
        console.log(`❌ НЕ ВІДПРАВЛЕНО: Chat ID не налаштовано для ${username}`);
        console.log(`📱 Повідомлення: ${message}`);
        console.log(`🔧 Щоб отримати Chat ID, напишіть боту /start і перевірте логи`);
      } else {
        await bot.sendMessage(config.telegram.chatId, message);
        console.log(`✅ Повідомлення відправлено для ${username} (саме став неактивним)`);
      }
    } catch (error) {
      console.error(`❌ Помилка відправки повідомлення для ${username}:`, error.message);
    }
      }
  }

// Функція для перевірки всіх користувачів
async function checkAllUsers() {
  const startTime = new Date();
  
  let activeUsers = 0;
  let inactiveUsers = 0;
  let newInactiveUsers = 0;
  
  for (const user of config.users) {
    const userStartTime = Date.now();
    await checkUserActivity(user);
    
    // Підрахунок статистики
    const userState = userStates.get(user.username);
    if (userState === 'active') {
      activeUsers++;
    } else if (userState === 'inactive') {
      inactiveUsers++;
      if (userStates.get(user.username + '_wasActive') !== true) {
        newInactiveUsers++;
        userStates.set(user.username + '_wasActive', true);
      }
    }
    
    // Невелика затримка між запитами до API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Налаштування cron-завдання
console.log(`⏰ Запуск бота з розкладом: ${config.schedule.cron}`);
console.log(`⏱️ Поріг неактивності: ${config.inactivityThreshold.minutes} хвилин`);
console.log(`🌍 Часовий пояс системи: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
if (config.server) {
  console.log(`🌐 Сервер: ${config.server.host}:${config.server.port}`);
}

// Запуск cron-завдання
cron.schedule(config.schedule.cron, () => {
  checkAllUsers();
});

// Запуск першої перевірки при старті бота
checkAllUsers();

// Обробка помилок
process.on('unhandledRejection', (reason, promise) => {
  console.error('Необроблена помилка Promise:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Необроблена помилка:', error);
});

console.log('Бот запущений і готовий до роботи!'); 