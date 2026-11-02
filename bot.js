// Telegram bot: /duke opens the chat's single pit.
// Extra /duke commands while a pit is waiting or mid-fight get a short notice pointing at that pit;
// after 15 seconds the bot deletes both the notice and the person's /duke so the chat stays clean.
// The bot must be an admin with "Delete messages" permission for the cleanup to work.
import { Bot, InlineKeyboard } from 'grammy';

const CLEANUP_MS = 15_000;

export function startBot({ token, username, appShort, openRoom, chatKey }) {
  const bot = new Bot(token);
  const app = param => `https://t.me/${username}/${appShort}?startapp=${param}`;
  const link = (id, spec) => app(`${id}${spec ? '_s' : ''}`);
  // profile links from a group remember that group, so the profile can start / join / watch its fights
  const profileLink = chat => app(chat && chat.type !== 'private' ? `profile_${chatKey(chat.id)}` : 'profile');
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const del = (chatId, msgId) => bot.api.deleteMessage(chatId, msgId).catch(() => {}); // ignore if already gone or no rights
  const PROFILE_BTN = '🏆 Profile · Skins · Leaderboard';

  const lobbyText = opener => `🐸⚔️🐸 <b>A PIT IS OPEN</b>${opener ? ` (opened by <b>${esc(opener)}</b>)` : ''}\n<b>Kiki</b> the tree frog vs <b>Riri</b> the toad.\nFirst to join picks Kiki or Riri, the next fighter gets the other. Everyone after that spectates.`;
  const lobbyKb = (roomId, chat) => new InlineKeyboard().url('🩸 Join', link(roomId)).url('👀 Spectate', link(roomId, true)).row().url(PROFILE_BTN, profileLink(chat));

  // /help
  const HELP = '/duke to play 1v1 Kiki vs Riri Mortal Frogbat.';
  bot.command('help', ctx => ctx.reply(HELP));

  bot.command('start', ctx => ctx.reply(
    '🐸 <b>MORTAL FROGBAT</b>\nAdd me to a group as an admin and type /duke. The first two people to tap Join fight, everyone else watches live.\nThe Profile button on every /duke post shows your record, skins and the leaderboard.',
    { parse_mode: 'HTML' }));

  bot.command('duke', async ctx => {
    if (ctx.chat.type === 'private') return ctx.reply('Fights happen in group chats. Add me to a group and type /duke there.');
    const room = openRoom(ctx.chat.id);

    // First /duke: open the pit. This post and the opener's command stay in the chat.
    if (!room.existing) {
      await ctx.reply(lobbyText(), { parse_mode: 'HTML', reply_markup: lobbyKb(room.id, ctx.chat) });
      return;
    }

    // Extra /duke: point at the existing pit, then clean up both messages.
    let text, kb;
    if (room.state === 'live') {
      const [a, b] = room.names.map(esc);
      text = `🩸 <b>Game lobby is already live.</b>\n<b>${a || 'Kiki'}</b> (Kiki) vs <b>${b || 'Riri'}</b> (Riri) is fighting now. Click to spectate.\nA new lobby opens when this fight ends.`;
      kb = new InlineKeyboard().url('👀 Spectate', link(room.id, true)).row().url(PROFILE_BTN, profileLink(ctx.chat));
    } else {
      const [k, r] = room.names.map(esc);
      const status = room.picker ? `<b>${esc(room.picker)}</b> is choosing a fighter. ` : k ? `<b>${k}</b> is waiting as Kiki. ` : r ? `<b>${r}</b> is waiting as Riri. ` : '';
      text = `🐸 <b>Game lobby is already live.</b>\n${status}Click to join or click to spectate.`;
      kb = lobbyKb(room.id, ctx.chat);
    }
    const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => null);
    const chatId = ctx.chat.id, cmdId = ctx.message?.message_id;
    setTimeout(() => {
      if (cmdId) del(chatId, cmdId);
      if (sent) del(chatId, sent.message_id);
    }, CLEANUP_MS);
  });

  bot.api.setMyCommands([
    { command: 'duke', description: 'Play 1v1 Kiki vs Riri Mortal Frogbat' },
    { command: 'help', description: 'How to play' }
  ]).catch(() => {});

  bot.catch(err => console.error('bot error', err.message));
  bot.start({ onStart: () => console.log(`Bot @${username} running`) });

  return {
    announce(chatId, html) { bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' }).catch(e => console.error(e.message)); },
    // a game started from someone's profile: post the normal lobby message in the group
    postLobby(chatId, roomId, opener) {
      bot.api.sendMessage(chatId, lobbyText(opener), { parse_mode: 'HTML', reply_markup: lobbyKb(roomId, { id: chatId, type: 'group' }) }).catch(e => console.error(e.message));
    },
    async isMember(chatId, userId) {
      try { const m = await bot.api.getChatMember(chatId, userId); return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member); }
      catch { return false; }
    }
  };
}
