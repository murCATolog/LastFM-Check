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
    // Ігноруємо помилку
  }
  
  // Обробляємо команди
  if (text === '📊 Статус користувачів') {
    await showStatus(chatId);
  } else if (text === '🔄 Ручна перевірка') {
    await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
    await checkAllUsers(true);
  } else if (text === '⚙️ Управління акаунтами') {
    await showAccountManagement(chatId);
  } else if (text.startsWith('/start ')) {
    const command = text.replace('/start ', '');
    if (command.startsWith('disable_')) {
      const username = command.replace('disable_', '');
      await toggleAccountStatus(chatId, username, false);
    } else if (command.startsWith('enable_')) {
      const username = command.replace('enable_', '');
      await toggleAccountStatus(chatId, username, true);
    } else if (command === 'manual_check') {
      await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
      await checkAllUsers(true);
    } else {
      await showMainMenu(chatId);
    }
  } else if (text.includes('disable_')) {
    const match = text.match(/disable_(.+)/);
    if (match) {
      const username = match[1];
      await toggleAccountStatus(chatId, username, false);
    }
  } else if (text.includes('enable_')) {
    const match = text.match(/enable_(.+)/);
    if (match) {
      const username = match[1];
      await toggleAccountStatus(chatId, username, true);
    }
  } else if (text === 'manual_check') {
    await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
    await checkAllUsers(true);
  } else {
    // Для будь-якого іншого повідомлення показуємо головне меню
    await showMainMenu(chatId);
  }
});

// Обробка callback queries (inline кнопки)
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  try {
    if (data.startsWith('disable_')) {
      const username = data.replace('disable_', '');
      await toggleAccountStatus(chatId, username, false);
    } else if (data.startsWith('enable_')) {
      const username = data.replace('enable_', '');
      await toggleAccountStatus(chatId, username, true);
    } else if (data === 'back_to_menu') {
      await showMainMenu(chatId);
    } else if (data === 'manual_check') {
      await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
      await checkAllUsers(true);
    }
    
    // Відповідаємо на callback query
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    logErrorOnce('callback_query', '❌ Помилка обробки callback query');
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Помилка обробки запиту' });
  }
});

// Обробка помилок polling
bot.on('polling_error', (error) => {
  logErrorOnce('polling_error', '❌ Помилка polling Telegram бота');
  
  // Спробуємо перезапустити polling через 5 секунд
  setTimeout(() => {
    bot.stopPolling().then(() => {
      setTimeout(() => {
        bot.startPolling().catch(err => {
          logErrorOnce('polling_restart', '❌ Помилка перезапуску polling');
        });
      }, 1000);
    }).catch(err => {
      logErrorOnce('polling_stop', '❌ Помилка зупинки polling');
    });
  }, 5000);
});

// При запуску бота автоматично показуємо меню
bot.on('polling_start', async () => {
  if (config.telegram.chatId && config.telegram.chatId !== 'YOUR_CHAT_ID') {
    await showMainMenu(config.telegram.chatId);
  }
});

bot.on('polling_stop', () => {
  // Без логування
});

// Функція для показу головного меню
async function showMainMenu(chatId) {
  const welcomeMessage = `🎵 Last.fm Монітор

📊 Моніторимо ${config.users.length} користувачів:
${config.users.map(user => `• ${user.username}`).join('\n')}

⏰ Автоматична перевірка: кожні 30 хвилин
⏱️ Поріг неактивності: ${config.inactivityThreshold.minutes} хвилин`;

  const keyboard = {
    keyboard: [
      ['📊 Статус користувачів', '🔄 Ручна перевірка'],
      ['⚙️ Управління акаунтами']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };

  await bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
}

// Функція для показу статусу
async function showStatus(chatId) {
  let statusMessage = `📊 Статус користувачів:\n\n`;
  
  for (const user of config.users) {
    if (user.disabled) {
      statusMessage += `${user.username} ⏸️\n`;
    } else {
      const userState = userStates.get(user.username);
      if (userState === 'active') {
        statusMessage += `${user.username} ✅\n`;
      } else if (userState === 'inactive') {
        const inactiveData = inactiveUsersData.get(user.username);
        if (inactiveData) {
          statusMessage += `${user.username} ❌ (${inactiveData.timeInactive})\n`;
        } else {
          statusMessage += `${user.username} ❌\n`;
        }
      } else {
        statusMessage += `${user.username} ✅\n`;
      }
    }
  }
  
  await bot.sendMessage(chatId, statusMessage);
}

// Функція для управління акаунтами
async function showAccountManagement(chatId) {
  // Створюємо inline кнопки для кожного користувача
  const keyboard = {
    inline_keyboard: []
  };
  
  for (const user of config.users) {
    const userState = userStates.get(user.username);
    let statusText = '';
    
    if (user.disabled) {
      statusText = '⏸️';
    } else if (userState === 'inactive') {
      const inactiveData = inactiveUsersData.get(user.username);
      if (inactiveData) {
        statusText = `❌ (${inactiveData.timeInactive})`;
      } else {
        statusText = '❌';
      }
    } else {
      statusText = '✅';
    }
    
    if (user.disabled) {
      keyboard.inline_keyboard.push([{
        text: `Увім: ${user.username} ${statusText}`,
        callback_data: `enable_${user.username}`
      }]);
    } else {
      keyboard.inline_keyboard.push([{
        text: `Вим: ${user.username} ${statusText}`,
        callback_data: `disable_${user.username}`
      }]);
    }
  }
  
  const message = `⚙️ Управління акаунтами\n\nНатисніть на кнопку для зміни статусу:`;
  await bot.sendMessage(chatId, message, { reply_markup: keyboard });
}



// Функція для перемикання статусу акаунта
async function toggleAccountStatus(chatId, username, enabled) {
  const user = config.users.find(u => u.username === username);
  
  if (!user) {
    await bot.sendMessage(chatId, `❌ Користувач "${username}" не знайдений!`);
    return;
  }
  
  user.disabled = !enabled;
  
  // Зберігаємо оновлену конфігурацію
  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    
    const status = enabled ? 'увімкнено' : 'вимкнено';
    await bot.sendMessage(chatId, `✅ Акаунт "${username}" ${status}!`);
    
    // Показуємо оновлене меню управління
    await showAccountManagement(chatId);
  } catch (error) {
    logErrorOnce('config_save', '❌ Помилка збереження конфігурації');
    await bot.sendMessage(chatId, `❌ Помилка збереження конфігурації!`);
  }
}

// Функція для формування таблиці неактивних користувачів
function formatInactiveUsersTable() {
  if (inactiveUsersData.size === 0) {
    return null;
  }
  
  const sortedInactiveUsers = Array.from(inactiveUsersData.values())
    .sort((a, b) => b.minutesInactive - a.minutesInactive);
  
  let tableMessage = ` Неактивні Last.fm профілі:\n\n`;
  
  for (const user of sortedInactiveUsers) {
    const clickableLink = `<a href="${user.lastfmProfile}">${user.lastfmUsername}</a>`;
    const statusIcon = user.isApiError ? '' : '';

    let displayTime = user.timeInactive;
    if (!user.isApiError && typeof user.minutesInactive === 'number') {
      const m = user.minutesInactive;
      const hours = Math.floor(m / 60);
      const minutes = m % 60;
      if (hours > 0) {
        displayTime = `${hours} год ${minutes} хв`;
      } else {
        displayTime = `${minutes} хв`;
      }
    }
    
    tableMessage += `${statusIcon} <b>${user.username}</b> | ${clickableLink}\n ${displayTime}\n`;
  }
  
  return tableMessage;
}



// Зберігання стану користувачів (активний/неактивний)
const userStates = new Map();

// Зберігання детальної інформації про неактивних користувачів
const inactiveUsersData = new Map();

// Зберігання показаних помилок (щоб не дублювати)
const shownErrors = new Set();

// Функція для показу помилки тільки один раз
function logErrorOnce(errorKey, errorMessage) {
  if (!shownErrors.has(errorKey)) {
    console.error(errorMessage);
    shownErrors.add(errorKey);
  }
}

// Функція для отримання останнього треку з Last.fm API
async function getLastTrack(username) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get('https://ws.audioscrobbler.com/2.0/', {
        params: {
          method: 'user.getrecenttracks',
          user: username,
          api_key: config.lastfm.apiKey,
          format: 'json',
          limit: 1,
          _: Date.now()
        },
        timeout: 10000,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (!response.data || !response.data.recenttracks || !response.data.recenttracks.track) {
        return null;
      }

      const tracks = response.data.recenttracks.track;
      if (Array.isArray(tracks) && tracks.length > 0) {
        const lastTrack = tracks[0];
        return processTrackData(lastTrack, username);
      }
      if (tracks && typeof tracks === 'object') {
        return processTrackData(tracks, username);
      }
      return null;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return null;
}

// Допоміжна функція для обробки даних треку
function processTrackData(track, username) {
  try {
    // Перевіряємо чи трек зараз грає
    const isNowPlaying = track['@attr'] && track['@attr'].nowplaying === 'true';
    
    if (isNowPlaying) {
      return {
        timestamp: 0, // Спеціальне значення для now playing
        track: track.name || 'Невідомий трек',
        artist: track.artist && track.artist['#text'] ? track.artist['#text'] : 'Невідомий виконавець',
        isNowPlaying: true
      };
    }
    
    // Якщо трек не грає зараз, але немає коректного date.uts — вважаємо дані ненадійними
    if (!track.date || !track.date.uts) {
      return null;
    }
    
    let timestamp = parseInt(track.date.uts);
    
    // Якщо timestamp виглядає як мілісекунди (занадто великий), конвертуємо в секунди
    if (timestamp > 10000000000) {
      timestamp = Math.floor(timestamp / 1000);
    }
    
    // Перевіряємо чи timestamp валідний
    if (isNaN(timestamp) || timestamp < 1000000000) {
      // Якщо timestamp невалідний, використовуємо 0
      return {
        timestamp: 0,
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
      const existingData = inactiveUsersData.get(username);
      if (existingData && existingData.isApiError) {
        const timeSinceError = Math.floor((Date.now() - (existingData.errorTimestamp || Date.now())) / 1000 / 60);
        const hoursInactive = Math.floor(timeSinceError / 60);
        const daysInactive = Math.floor(hoursInactive / 24);
        let timeMessage = '';
        if (daysInactive > 0) {
          timeMessage = `${daysInactive} д ${hoursInactive % 24} год (API помилка)`;
        } else if (hoursInactive > 0) {
          timeMessage = `${hoursInactive} год ${timeSinceError % 60} хв (API помилка)`;
        } else {
          timeMessage = `${timeSinceError} хв (API помилка)`;
        }
        inactiveUsersData.set(username, {
          username: username,
          lastfmProfile: user.lastfmProfile,
          lastfmUsername: lastfmUsername,
          timeInactive: timeMessage,
          minutesInactive: timeSinceError,
          isApiError: true,
          errorTimestamp: existingData.errorTimestamp || Date.now()
        });
      } else {
        inactiveUsersData.set(username, {
          username: username,
          lastfmProfile: user.lastfmProfile,
          lastfmUsername: lastfmUsername,
          timeInactive: 'API помилка',
          minutesInactive: 999999,
          isApiError: true,
          errorTimestamp: Date.now()
        });
      }
      if (!userStates.get(username + '_initialized')) {
        userStates.set(username + '_initialized', true);
      }
      return;
    }
    
    // Якщо користувач зараз слухає музику, він точно активний
    if (lastTrackData.isNowPlaying) {
      userStates.set(username, 'active');
      userStates.set(username + '_initialized', true);
      // Видаляємо з неактивних, якщо був там
      inactiveUsersData.delete(username);
      return;
    }
    
    // Використовуємо UTC час для порівняння з Last.fm timestamp
    const currentTimeUTC = Math.floor(Date.now() / 1000);
    // Чистий розрахунок без будь-яких зсувів; від’ємні значення обрізаємо до 0
    const rawDelta = lastTrackData.timestamp === 0 ? 0 : (currentTimeUTC - lastTrackData.timestamp);
    const timeSinceLastTrack = rawDelta < 0 ? 0 : rawDelta;
    const thresholdMinutes = config.inactivityThreshold.minutes;
    const thresholdSeconds = thresholdMinutes * 60;
    
    // Якщо timeSinceLastTrack більше порогу - неактивний
    const isCurrentlyInactive = timeSinceLastTrack > thresholdSeconds;
    
    
    // Оновлюємо стан користувача
    userStates.set(username, isCurrentlyInactive ? 'inactive' : 'active');
    
    // Якщо профіль неактивний більше порогу - зберігаємо дані для подальшого повідомлення
    if (isCurrentlyInactive) {
      // ЗАВЖДИ обчислюємо актуальний час неактивності
      const minutesInactive = Math.floor(timeSinceLastTrack / 60);
      const hoursInactive = Math.floor(minutesInactive / 60);
      const daysInactive = Math.floor(hoursInactive / 24);
      
      let timeMessage = '';
      if (daysInactive > 0) {
        timeMessage = `${daysInactive} д ${hoursInactive % 24} год`;
      } else if (hoursInactive > 0) {
        timeMessage = `${hoursInactive} год ${minutesInactive % 60} хв`;
      } else {
        timeMessage = `${minutesInactive} хв`;
      }
      
      // Оновлюємо або створюємо дані про неактивного користувача
      inactiveUsersData.set(username, {
        username: username,
        lastfmProfile: user.lastfmProfile,
        lastfmUsername: lastfmUsername,
        timeInactive: timeMessage,
        minutesInactive: minutesInactive,
        isApiError: false
      });
    } else {
      // Якщо користувач активний, видаляємо його з неактивних
      inactiveUsersData.delete(username);
    }
    
    // Встановлюємо прапорець ініціалізації
    if (!userStates.get(username + '_initialized')) {
      userStates.set(username + '_initialized', true);
    }
  } catch (error) {
    // При помилці вважаємо користувача неактивним
    userStates.set(username, 'inactive');
  }
}

// Функція для перевірки всіх користувачів
async function checkAllUsers(isManualCheck = false) {
  let activeUsers = 0;
  let inactiveUsers = 0;
  let errorUsers = 0;
  let disabledUsers = 0;
  
  // Очищуємо дані про неактивних користувачів для актуальної перевірки
  inactiveUsersData.clear();
  
  for (let i = 0; i < config.users.length; i++) {
    const user = config.users[i];
    
    // Пропускаємо вимкнені акаунти
    if (user.disabled) {
      disabledUsers++;
      continue;
    }
    
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
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  
  // Відправляємо повідомлення з таблицею неактивних користувачів
  if (inactiveUsersData.size > 0 && config.telegram.chatId !== 'YOUR_CHAT_ID') {
    const tableMessage = formatInactiveUsersTable();
    if (tableMessage) {
      try {
        await bot.sendMessage(config.telegram.chatId, tableMessage, { 
          parse_mode: 'HTML',
          disable_web_page_preview: true 
        });
      } catch (error) {
        logErrorOnce('send_inactive_table', '❌ Помилка відправки таблиці неактивних користувачів');
      }
    }
  } else if (config.telegram.chatId !== 'YOUR_CHAT_ID' && isManualCheck) {
    // Відправляємо повідомлення про те, що всі профілі активні (тільки при ручній перевірці)
    try {
      await bot.sendMessage(config.telegram.chatId, '✅ Всі профілі активні!');
    } catch (error) {
      logErrorOnce('send_active_message', '❌ Помилка відправки повідомлення про активні профілі');
    }
  }
}

// Налаштування cron-завдання
cron.schedule(config.schedule.cron, async () => {
  try {
    await checkAllUsers();
  } catch (error) {
    logErrorOnce('auto_check', '❌ Помилка автоматичної перевірки');
  }
});

// Перша перевірка відбудеться автоматично по cron розкладу

// Бот запущений
console.log('🤖 Last.fm Monitor Bot запущений!');

// Обробка помилок
process.on('unhandledRejection', (reason, promise) => {
  logErrorOnce('unhandled_rejection', '❌ Необроблена помилка Promise');
});

process.on('uncaughtException', (error) => {
  logErrorOnce('uncaught_exception', '❌ Необроблена помилка');
});

// Обробка сигналів завершення
process.on('SIGINT', () => {
  bot.stopPolling().then(() => {
    process.exit(0);
  }).catch(error => {
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  bot.stopPolling().then(() => {
    process.exit(0);
  }).catch(error => {
    process.exit(1);
  });
}); 