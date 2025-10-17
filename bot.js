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
    await showStatus(chatId);
  } else if (text === '🔄 Ручна перевірка') {
    await runManualCheck(chatId);
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
      await runManualCheck(chatId);
    } else {
      showMainMenu(chatId);
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
    await runManualCheck(chatId);
  } else {
    // Для будь-якого іншого повідомлення показуємо головне меню
    showMainMenu(chatId);
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
      showMainMenu(chatId);
    } else if (data === 'manual_check') {
      await runManualCheck(chatId);
    }
    
    // Відповідаємо на callback query
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error('❌ Помилка обробки callback query:', error.message);
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Помилка обробки запиту' });
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
      ['📊 Статус користувачів', '🔄 Ручна перевірка'],
      ['⚙️ Управління акаунтами']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };

  bot.sendMessage(chatId, welcomeMessage, { reply_markup: keyboard });
}

// Функція для показу статусу
async function showStatus(chatId) {
  // Оновлюємо статуси перед показом
  for (const user of config.users) {
    if (!user.disabled) {
      await checkUserActivity(user);
    }
  }
  
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
  
  bot.sendMessage(chatId, statusMessage);
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
  bot.sendMessage(chatId, message, { reply_markup: keyboard });
}

// Функція для ручної перевірки
async function runManualCheck(chatId) {
  await bot.sendMessage(chatId, '🔄 Запускаю перевірку...');
  await checkAllUsers();
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
    console.error(`❌ Помилка збереження конфігурації:`, error.message);
    await bot.sendMessage(chatId, `❌ Помилка збереження конфігурації!`);
  }
}

// Функція для формування таблиці неактивних користувачів
function formatInactiveUsersTable() {
  if (inactiveUsersData.size === 0) {
    return null;
  }
  
  // Сортуємо користувачів за часом неактивності (від більшого до меншого)
  const sortedInactiveUsers = Array.from(inactiveUsersData.values())
    .sort((a, b) => b.minutesInactive - a.minutesInactive);
  
  let tableMessage = `⚠️ Неактивні Last.fm профілі:\n\n`;
  
  for (const user of sortedInactiveUsers) {
    // Форматуємо посилання як клікабельне ім'я
    const clickableLink = `<a href="${user.lastfmProfile}">${user.lastfmUsername}</a>`;
    
    // Додаємо іконку для API помилок
    const statusIcon = user.isApiError ? '🔴' : '🍌';
    
    tableMessage += `${statusIcon} <b>${user.username}</b> | ${clickableLink}\n⏱️ ${user.timeInactive}\n`;
  }
  
  return tableMessage;
}



// Зберігання стану користувачів (активний/неактивний)
const userStates = new Map();

// Зберігання детальної інформації про неактивних користувачів
const inactiveUsersData = new Map();

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
        timestamp: 0, // Спеціальне значення для now playing
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
      
      // Зберігаємо дані про користувача з проблемами API
      if (wasPreviouslyActive) {
        inactiveUsersData.set(username, {
          username: username,
          lastfmProfile: user.lastfmProfile,
          lastfmUsername: lastfmUsername,
          timeInactive: 'API помилка',
          minutesInactive: 999999,
          isApiError: true
        });
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
      // Видаляємо з неактивних, якщо був там
      inactiveUsersData.delete(username);
      return;
    }
    
    const currentTime = Math.floor(Date.now() / 1000);
    const timeSinceLastTrack = lastTrackData.timestamp === 0 ? 0 : currentTime - lastTrackData.timestamp;
    const thresholdMinutes = config.inactivityThreshold.minutes;
    const thresholdSeconds = thresholdMinutes * 60;
    
    const isCurrentlyInactive = timeSinceLastTrack > thresholdSeconds;
    
    // Оновлюємо стан користувача
    userStates.set(username, isCurrentlyInactive ? 'inactive' : 'active');
    
    // Якщо профіль неактивний більше порогу - зберігаємо дані для подальшого повідомлення
    if (isCurrentlyInactive) {
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
      
      // Зберігаємо дані про неактивного користувача
      inactiveUsersData.set(username, {
        username: username,
        lastfmProfile: user.lastfmProfile,
        lastfmUsername: lastfmUsername,
        timeInactive: timeMessage,
        minutesInactive: minutesInactive
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Відправляємо єдине повідомлення з таблицею неактивних користувачів
  if (inactiveUsersData.size > 0 && config.telegram.chatId !== 'YOUR_CHAT_ID') {
    const tableMessage = formatInactiveUsersTable();
    if (tableMessage) {
      try {
        await bot.sendMessage(config.telegram.chatId, tableMessage, { 
          parse_mode: 'HTML',
          disable_web_page_preview: true 
        });
      } catch (error) {
        console.error('❌ Помилка відправки таблиці неактивних користувачів:', error.message);
      }
    }
  }
}

// Налаштування cron-завдання
cron.schedule(config.schedule.cron, async () => {
  try {
    await checkAllUsers();
  } catch (error) {
    console.error('❌ Помилка автоматичної перевірки:', error.message);
  }
});

// Перша перевірка відбудеться автоматично по cron розкладу

// Бот запущений

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