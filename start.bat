@echo off
chcp 65001 >nul

echo 🎵 Last.fm Monitor Bot
echo ==========================

REM Зупиняємо попередній процес якщо він запущений
taskkill /f /im node.exe 2>nul

REM Запускаємо бота
echo 🚀 Запускаю бота...
echo 📱 Напишіть боту /start для початку роботи
echo ⏹️  Для зупинки натисніть Ctrl+C
echo ==========================

node bot.js 