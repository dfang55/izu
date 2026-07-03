const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ChannelType, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const { calculateRisk } = require('./risks');
const { makeCheckEmbed } = require('./embeds');
const {
  handleSetTicketCommand,
  handleTicketCommand,
  handleTicketInteraction,
  loadTicketConfigs
} = require('./ticket');
const mongoose = require('mongoose');
require('dotenv').config();

const ServerConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  reactionLogsChannel: { type: String, default: null },
  deletedLogsChannel: { type: String, default: null },
  editLogsChannel: { type: String, default: null },
  modLogsChannel: { type: String, default: null },
  watchLogChannel: { type: String, default: null },
  warnDeleteTimeout: { type: Number, default: 60 },
  quarantine: {
    enabled: { type: Boolean, default: false },
    ageThreshold: { type: Number, default: 0 },
    ageEnabled: { type: Boolean, default: false },
    massJoinEnabled: { type: Boolean, default: false },
    massJoinTime: { type: Number, default: 5 },
    massJoinCount: { type: Number, default: 10 },
    profileCheckEnabled: { type: Boolean, default: false },
    linkCheckEnabled: { type: Boolean, default: false }
  }
});

const AdvancedChannelConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  mode: { type: String, default: null },
  restrictedRoles: { type: [String], default: [] },
  restrictedUsers: { type: [String], default: [] },
  exemptRoles: { type: [String], default: [] },
  exemptUsers: { type: [String], default: [] }
});
AdvancedChannelConfigSchema.index({ guildId: 1, channelId: 1 }, { unique: true });

const ServerConfigModel = mongoose.model('IzumiServerConfig', ServerConfigSchema);
const AdvancedChannelConfigModel = mongoose.model('IzumiAdvancedConfig', AdvancedChannelConfigSchema);

const ActivityLogSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  date: { type: String, required: true },
  messages: { type: Number, default: 0 },
  links: { type: Number, default: 0 },
  mentions: { type: Number, default: 0 },
  uniqueChannels: { type: [String], default: [] }
});
ActivityLogSchema.index({ guildId: 1, userId: 1, date: 1 }, { unique: true });
const ActivityLogModel = mongoose.model('IzumiActivityLog', ActivityLogSchema);

const QuarantinedUserSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  savedRoles: { type: [String], default: [] },
  quarantineChannelId: { type: String, default: null },
  reason: { type: String, default: '' },
  quarantinedBy: { type: String, default: 'Automatic' },
  quarantinedAt: { type: Date, default: Date.now }
});
QuarantinedUserSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const QuarantinedUserModel = mongoose.model('IzumiQuarantinedUser', QuarantinedUserSchema);

const MemberTrustSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  messageCount: { type: Number, default: 0 },
  warningCount: { type: Number, default: 0 },
  flagCount: { type: Number, default: 0 },
  quarantineCount: { type: Number, default: 0 },
  firstSeenAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
});
MemberTrustSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const MemberTrustModel = mongoose.model('IzumiMemberTrust', MemberTrustSchema);

const WarnSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  warnedBy: { type: String, required: true },
  reason: { type: String, default: 'No reason provided' },
  timestamp: { type: Date, default: Date.now },
  warnId: { type: String, required: true, unique: true }
});
WarnSchema.index({ guildId: 1, userId: 1 });
const WarnModel = mongoose.model('IzumiWarn', WarnSchema);

const WatchlistSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  addedBy: { type: String, required: true },
  reason: { type: String, default: 'No reason provided' },
  addedAt: { type: Date, default: Date.now }
});
WatchlistSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const WatchlistModel = mongoose.model('IzumiWatchlist', WatchlistSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences
  ]
});

// Storage for server configurations (in production, use a database)
const serverConfigs = new Map();
const joinLog = new Map();
const userFirstMessage = new Map();
const advancedConfig = new Map(); // guildId -> Map<channelId, ChannelConfig>

// Snipe caches — keyed by channelId, hold the most recent event per channel
const snipeDeleteCache = new Map();   // channelId -> { author, content, attachments, deletedAt }
const snipeEditCache = new Map();     // channelId -> { author, before, after, messageUrl, editedAt }
const snipeReactionCache = new Map(); // channelId -> { user, emoji, messageContent, messageUrl, messageAuthorTag, removedAt }

// Suspicious mention velocity tracker
// key: `${guildId}_${userId}` -> [{ mentionedId, timestamp }]
const mentionTracker = new Map();
const MENTION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MENTION_ALERT_THRESHOLD = 5;        // unique users mentioned before alert fires

// In-memory watchlist cache: guildId -> Set<userId>
const watchlistCache = new Map();

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('check')
    .setDescription('Check if a user is potentially an alt account')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to check')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('configure')
    .setDescription('Configure security settings')
    .addSubcommand(subcommand =>
      subcommand
        .setName('quarantine')
        .setDescription('Configure the quarantine system')),

  new SlashCommandBuilder()
    .setName('quarantine')
    .setDescription('Manually quarantine a user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to quarantine')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('allow')
    .setDescription('Allow a quarantined user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to allow')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Get information about the current server'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('Get detailed information about a user')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to get info about')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('althistory')
    .setDescription('View recent alt account checks in this server')
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Number of recent checks to show (1-10)')
        .setMinValue(1)
        .setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('setreactionlogs')
    .setDescription('Configure reaction logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('setdeletedlogs')
    .setDescription('Configure deleted message logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('seteditlogs')
    .setDescription('Configure message edit logging channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('logstatus')
    .setDescription('View current logging configuration (Moderator only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message to a specified channel (Admin only)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to send the message to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('The message to send')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('riskreport')
    .setDescription('Generate a comprehensive server security and safety assessment')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('behavioursummary')
    .setDescription('Analyze a user\'s activity patterns and message history')
    .addUserOption(option => 
      option.setName('user')
        .setDescription('The user to analyze')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete messages from a channel or server-wide')
    .addStringOption(option =>
      option.setName('scope')
        .setDescription('Where to delete messages')
        .setRequired(true)
        .addChoices(
          { name: 'This channel only', value: 'channel' },
          { name: 'Server-wide (all channels)', value: 'server' }
        ))
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user whose messages to delete (leave blank to delete all messages)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('User ID whose messages to delete (alternative to selecting a user)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('limit')
        .setDescription('Max number of messages to delete (leave blank for all within Discord\'s 14-day window)')
        .setMinValue(1)
        .setMaxValue(5000)
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('advanced')
    .setDescription('Advanced content restriction controls')
    .addSubcommand(subcommand =>
      subcommand
        .setName('toggle')
        .setDescription('Configure per-channel content restrictions, role jurisdiction, and user exemptions'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('setticket')
    .setDescription('Set up the ticket system for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket management commands')
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Soft-close this ticket — members cannot send messages, but the channel is kept'))
    .addSubcommand(sub =>
      sub.setName('transcript').setDescription('Save a transcript of this ticket to the log channel, then delete the channel'))
    .addSubcommand(sub =>
      sub.setName('delete').setDescription('Delete this ticket channel immediately (warns if no transcript was saved)'))
    .addSubcommand(sub =>
      sub.setName('lock').setDescription('Prevent members from sending messages in this ticket'))
    .addSubcommand(sub =>
      sub.setName('unlock').setDescription('Allow members to send messages in this ticket again'))
    .addSubcommand(sub =>
      sub.setName('roles').setDescription('Update which roles have access to this ticket')),

  new SlashCommandBuilder()
    .setName('searchuser')
    .setDescription('Look up a detailed profile for any Discord user by their ID')
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('The Discord user ID to search')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('setmodlogs')
    .setDescription('Configure the mod action logs channel (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user from the server by their ID')
    .addStringOption(option =>
      option.setName('userid')
        .setDescription('The ID of the user to unban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the unban')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to kick')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the kick')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to ban')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the ban')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('delete_days')
        .setDescription('Number of days of messages to delete (0–7)')
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a member, preventing them from sending messages')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to timeout')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('duration')
        .setDescription('How long to timeout the member')
        .setRequired(true)
        .addChoices(
          { name: '60 seconds', value: '60' },
          { name: '5 minutes',  value: '300' },
          { name: '10 minutes', value: '600' },
          { name: '30 minutes', value: '1800' },
          { name: '1 hour',     value: '3600' },
          { name: '6 hours',    value: '21600' },
          { name: '12 hours',   value: '43200' },
          { name: '1 day',      value: '86400' },
          { name: '1 week',     value: '604800' }
        ))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the timeout')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('trust')
    .setDescription('Check the trust score of a server member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to check')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a server member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to warn')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for the warning')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View all warnings for a server member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to look up')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('clearwarn')
    .setDescription('Remove a specific warning by its ID')
    .addStringOption(option =>
      option.setName('warnid')
        .setDescription('The warning ID to remove')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Clear all warnings for a server member')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to clear')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Place a user under silent observation — deleted messages, edits, and reactions are auto-logged')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to watch')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for watching this user')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Remove a user from the watchlist')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The member to unwatch')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('watchlist')
    .setDescription('Show all currently watched users in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('setwatchlog')
    .setDescription('Set the channel where watchlist edits and reactions are logged (privately)')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('The channel to post watch logs to')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// Helper functions for permissions
function isAdmin(member) {
  return member.permissions.has('Administrator') || member.permissions.has('ManageGuild');
}

function isModerator(member) {
  return member.permissions.has('ModerateMembers') || member.permissions.has('BanMembers') || member.permissions.has('KickMembers') || isAdmin(member);
}

// Trust score calculator
function calculateTrustScore(member, trustData) {
  let score = 50;

  // Account age
  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86400000;
  if (accountAgeDays > 730) score += 15;
  else if (accountAgeDays > 365) score += 10;
  else if (accountAgeDays > 90) score += 5;
  else if (accountAgeDays < 7) score -= 10;

  // Time in server
  const joinDays = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 86400000 : 0;
  if (joinDays > 365) score += 15;
  else if (joinDays > 90) score += 10;
  else if (joinDays > 30) score += 5;
  else if (joinDays < 1) score -= 5;

  // Message activity
  const messages = trustData?.messageCount || 0;
  if (messages > 1000) score += 10;
  else if (messages > 100) score += 7;
  else if (messages > 10) score += 3;

  // Server booster
  if (member.premiumSince) score += 10;

  // Has multiple roles (shows integration)
  const roleCount = member.roles.cache.size - 1;
  if (roleCount >= 3) score += 5;

  // Warnings
  const warnings = trustData?.warningCount || 0;
  score -= Math.min(warnings * 10, 30);

  // Flags (alt detection / risk flags)
  const flags = trustData?.flagCount || 0;
  score -= Math.min(flags * 15, 30);

  // Quarantine history
  const quarantines = trustData?.quarantineCount || 0;
  if (quarantines > 0) score -= 20;

  score = Math.max(0, Math.min(100, score));

  let label, color;
  if (score >= 80) { label = 'Trusted'; color = 0x00C853; }
  else if (score >= 60) { label = 'Good Standing'; color = 0x69F0AE; }
  else if (score >= 40) { label = 'Neutral'; color = 0xFFD600; }
  else if (score >= 20) { label = 'Caution'; color = 0xFF6D00; }
  else { label = 'Low Trust'; color = 0xD50000; }

  return { score, label, color };
}

// Watchlist cache helper — lazy-loads from DB on first use per guild
async function isWatched(guildId, userId) {
  let cached = watchlistCache.get(guildId);
  if (!cached) {
    const docs = await WatchlistModel.find({ guildId }).lean().catch(() => []);
    cached = new Set(docs.map(d => d.userId));
    watchlistCache.set(guildId, cached);
  }
  return cached.has(userId);
}

// Helper function to get server config
function getServerConfig(guildId) {
  if (!serverConfigs.has(guildId)) {
    serverConfigs.set(guildId, {
      reactionLogsChannel: null,
      deletedLogsChannel: null,
      editLogsChannel: null,
      modLogsChannel: null,
      watchLogChannel: null,
      warnDeleteTimeout: 60,
      quarantine: {
        enabled: false,
        ageThreshold: 0,
        ageEnabled: false,
        massJoinEnabled: false,
        massJoinTime: 5,
        massJoinCount: 10,
        profileCheckEnabled: false,
        linkCheckEnabled: false
      }
    });
  }
  if (serverConfigs.get(guildId).warnDeleteTimeout === undefined) {
    serverConfigs.get(guildId).warnDeleteTimeout = 60;
  }
  return serverConfigs.get(guildId);
}

// ---- Advanced config helpers ----

function getAdvancedGuildConfig(guildId) {
  if (!advancedConfig.has(guildId)) advancedConfig.set(guildId, new Map());
  return advancedConfig.get(guildId);
}

function getAdvancedChannelConfig(guildId, channelId) {
  const guildCfg = getAdvancedGuildConfig(guildId);
  if (!guildCfg.has(channelId)) {
    guildCfg.set(channelId, {
      mode: null,
      restrictedRoles: [],
      restrictedUsers: [],
      exemptRoles: [],
      exemptUsers: []
    });
  }
  return guildCfg.get(channelId);
}

function isSubjectToAdvancedRestriction(member, cfg) {
  if (cfg.exemptUsers.includes(member.id)) return false;
  if (cfg.exemptRoles.some(roleId => member.roles.cache.has(roleId))) return false;
  if (cfg.restrictedRoles.length > 0 || cfg.restrictedUsers.length > 0) {
    return cfg.restrictedRoles.some(roleId => member.roles.cache.has(roleId)) ||
           cfg.restrictedUsers.includes(member.id);
  }
  return true;
}

async function checkAdvancedRestrictions(message) {
  const guildCfg = advancedConfig.get(message.guild.id);
  if (!guildCfg) return false;

  const channelCfg = guildCfg.get(message.channel.id);
  if (!channelCfg || !channelCfg.mode) return false;

  const member = message.member;
  if (!member || isAdmin(member)) return false;
  if (!isSubjectToAdvancedRestriction(member, channelCfg)) return false;

  const warnTimeout = getServerConfig(message.guild.id).warnDeleteTimeout;
  const scheduleDelete = (msg) => {
    if (warnTimeout !== null) {
      setTimeout(() => msg.delete().catch(() => {}), warnTimeout * 1000);
    }
  };

  const sendAdvancedLog = async (reason) => {
    const serverCfg = getServerConfig(message.guild.id);
    if (!serverCfg.deletedLogsChannel) return;
    const logChannel = message.guild.channels.cache.get(serverCfg.deletedLogsChannel);
    if (!logChannel) return;
    const logEmbed = new EmbedBuilder()
      .setTitle('Message Deleted — Advanced Toggle')
      .setColor(0x9B59B6)
      .addFields(
        { name: 'Author', value: `${message.author.tag} (${message.author.id})`, inline: true },
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Deleted At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        { name: 'Reason', value: reason, inline: false }
      )
      .setTimestamp();
    if (message.content) {
      logEmbed.addFields({
        name: 'Content',
        value: message.content.length > 1024 ? `${message.content.substring(0, 1021)}...` : message.content,
        inline: false
      });
    }
    if (message.attachments.size > 0) {
      const attachmentList = message.attachments.map(att => `[${att.name}](${att.url})`).join('\n');
      logEmbed.addFields({
        name: 'Attachments',
        value: attachmentList.length > 1024 ? `${attachmentList.substring(0, 1021)}...` : attachmentList,
        inline: false
      });
    }
    logEmbed.setFooter({ text: `Message ID: ${message.id}` });
    await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
  };

  if (channelCfg.mode === 'messages_only') {
    const hasMedia = message.attachments.some(a =>
      a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/')
    ) || message.embeds.some(e => e.image || e.video || e.thumbnail);

    if (hasMedia) {
      const savedText = message.content?.trim() || '';
      await message.delete().catch(() => {});
      await sendAdvancedLog('Channel is set to **Messages Only** — message contained media.');
      const response = await message.channel.send({
        content: `${member}, this channel is set to **text only**. Your message was removed because it contained media.\n\n` +
          (savedText
            ? `Your text has been saved. Copy and resend it:\n\`\`\`\n${savedText.substring(0, 1800)}\n\`\`\``
            : 'Your message contained no text content.')
      });
      scheduleDelete(response);
      return true;
    }
  }

  if (channelCfg.mode === 'media_only') {
    const hasText = message.content && message.content.trim().length > 0;
    const hasAttachment = message.attachments.some(a =>
      a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/')
    );
    const hasLink = /https?:\/\/[^\s]+/.test(message.content || '');
    const hasMedia = hasAttachment || hasLink;
    if (hasText && !hasMedia) {
      await message.delete().catch(() => {});
      await sendAdvancedLog('Channel is set to **Media Only** — message contained no media, attachment, or link.');
      const response = await message.channel.send({
        content: `${member}, this channel is set to **media only**. Your message was removed because it contained no media.\n\n` +
          'Please include an image, video, or link with your message.'
      });
      scheduleDelete(response);
      return true;
    }
  }

  return false;
}

function buildAdvancedPanel(guild, channelId) {
  const guildCfg = getAdvancedGuildConfig(guild.id);
  const channel = guild.channels.cache.get(channelId);
  const cfg = guildCfg.has(channelId) ? guildCfg.get(channelId) : { mode: null, restrictedRoles: [], exemptRoles: [], exemptUsers: [] };
  const serverCfg = getServerConfig(guild.id);
  const timeout = serverCfg.warnDeleteTimeout;
  const timeoutLabel = timeout === null ? 'Never' : timeout < 60 ? `${timeout}s` : `${timeout / 60}min`;

  const modeLabel = cfg.mode === 'messages_only' ? 'Messages Only'
    : cfg.mode === 'media_only' ? 'Media Only'
    : 'Unrestricted';

  const modeColor = cfg.mode === 'messages_only' ? 0x5865F2
    : cfg.mode === 'media_only' ? 0x9B59B6
    : 0x36393F;

  const restrictedText = cfg.restrictedRoles.length > 0
    ? cfg.restrictedRoles.map(id => `<@&${id}>`).join(', ')
    : 'All members';

  const exemptRolesText = cfg.exemptRoles.length > 0
    ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ')
    : 'None';

  const exemptUsersText = cfg.exemptUsers.length > 0
    ? cfg.exemptUsers.map(id => `<@${id}>`).join(', ')
    : 'None';

  const embed = new EmbedBuilder()
    .setTitle(`Advanced Security | #${channel?.name || channelId}`)
    .setDescription('Configure content restrictions for this channel. Mode changes apply immediately.')
    .addFields(
      { name: 'Current Mode', value: `**${modeLabel}**`, inline: true },
      { name: 'Warning Auto-Delete', value: `**${timeoutLabel}**`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Restricted To', value: restrictedText, inline: true },
      { name: 'Exempt Roles', value: exemptRolesText, inline: true },
      { name: 'Exempt Users', value: exemptUsersText, inline: true }
    )
    .setColor(modeColor)
    .setFooter({ text: 'Administrators are always exempt. Use the selects below to manage roles and users.' })
    .setTimestamp();

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`adv_chan_${guild.id}`)
    .setPlaceholder(`Viewing: #${channel?.name || channelId} — select another to switch`)
    .setChannelTypes([ChannelType.GuildText])
    .setMinValues(1)
    .setMaxValues(1);

  const modeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`adv_mode_messages_${channelId}`)
      .setLabel('Messages Only')
      .setStyle(cfg.mode === 'messages_only' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_mode_media_${channelId}`)
      .setLabel('Media Only')
      .setStyle(cfg.mode === 'media_only' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_mode_off_${channelId}`)
      .setLabel('Unrestricted')
      .setStyle(!cfg.mode ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`adv_timer_${channelId}`)
      .setLabel(`Warning Timer: ${timeoutLabel}`)
      .setStyle(ButtonStyle.Secondary)
  );

  const restrictRolesSelect = new RoleSelectMenuBuilder()
    .setCustomId(`adv_roles_restrict_${channelId}`)
    .setPlaceholder('Restrict to these roles — leave empty to apply to all members')
    .setMinValues(0)
    .setMaxValues(25);

  const exemptRolesSelect = new RoleSelectMenuBuilder()
    .setCustomId(`adv_roles_exempt_${channelId}`)
    .setPlaceholder('Exempt these roles from restrictions')
    .setMinValues(0)
    .setMaxValues(25);

  const exemptUsersSelect = new UserSelectMenuBuilder()
    .setCustomId(`adv_users_exempt_${channelId}`)
    .setPlaceholder('Exempt these users from restrictions')
    .setMinValues(0)
    .setMaxValues(25);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      modeRow,
      new ActionRowBuilder().addComponents(restrictRolesSelect),
      new ActionRowBuilder().addComponents(exemptRolesSelect),
      new ActionRowBuilder().addComponents(exemptUsersSelect)
    ]
  };
}

// ---- MongoDB persistence ----

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
}

async function saveServerConfig(guildId) {
  try {
    const data = serverConfigs.get(guildId);
    if (!data) return;
    await ServerConfigModel.findOneAndUpdate(
      { guildId },
      { guildId, ...data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`Failed to save server config for ${guildId}:`, err);
  }
}

async function saveAdvancedChannelConfig(guildId, channelId) {
  try {
    const guildCfg = advancedConfig.get(guildId);
    if (!guildCfg) return;
    const data = guildCfg.get(channelId);
    if (!data) return;
    await AdvancedChannelConfigModel.findOneAndUpdate(
      { guildId, channelId },
      { guildId, channelId, ...data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`Failed to save advanced config for ${guildId}/${channelId}:`, err);
  }
}

async function loadAllConfigs() {
  try {
    const serverDocs = await ServerConfigModel.find({}).lean();
    for (const doc of serverDocs) {
      serverConfigs.set(doc.guildId, {
        reactionLogsChannel: doc.reactionLogsChannel ?? null,
        deletedLogsChannel: doc.deletedLogsChannel ?? null,
        editLogsChannel: doc.editLogsChannel ?? null,
        modLogsChannel: doc.modLogsChannel ?? null,
        watchLogChannel: doc.watchLogChannel ?? null,
        warnDeleteTimeout: doc.warnDeleteTimeout !== undefined ? doc.warnDeleteTimeout : 60,
        quarantine: {
          enabled: doc.quarantine?.enabled ?? false,
          ageThreshold: doc.quarantine?.ageThreshold ?? 0,
          ageEnabled: doc.quarantine?.ageEnabled ?? false,
          massJoinEnabled: doc.quarantine?.massJoinEnabled ?? false,
          massJoinTime: doc.quarantine?.massJoinTime ?? 5,
          massJoinCount: doc.quarantine?.massJoinCount ?? 10,
          profileCheckEnabled: doc.quarantine?.profileCheckEnabled ?? false,
          linkCheckEnabled: doc.quarantine?.linkCheckEnabled ?? false
        }
      });
    }

    const advancedDocs = await AdvancedChannelConfigModel.find({}).lean();
    for (const doc of advancedDocs) {
      if (!advancedConfig.has(doc.guildId)) advancedConfig.set(doc.guildId, new Map());
      advancedConfig.get(doc.guildId).set(doc.channelId, {
        mode: doc.mode ?? null,
        restrictedRoles: doc.restrictedRoles ?? [],
        restrictedUsers: doc.restrictedUsers ?? [],
        exemptRoles: doc.exemptRoles ?? [],
        exemptUsers: doc.exemptUsers ?? []
      });
    }

    console.log(`Loaded ${serverDocs.length} server config(s) and ${advancedDocs.length} advanced channel config(s) from MongoDB`);
  } catch (err) {
    console.error('Failed to load configs from MongoDB:', err);
  }
}

// ---- End MongoDB persistence ----

// ---- End advanced config helpers ----

async function quarantineUser(member, reason, moderator = null) {
  const guild = member.guild;

  // Check bot permissions upfront
  const botMember = guild.members.cache.get(client.user.id);
  if (!botMember) return { success: false, error: 'Could not resolve my own member object.' };
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { success: false, error: 'I am missing the Manage Roles permission.' };
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { success: false, error: 'I am missing the Manage Channels permission.' };
  }

  // Find or create the Quarantined role (no base permissions)
  let quarantineRole = guild.roles.cache.find(r => r.name === 'Quarantined');
  if (!quarantineRole) {
    try {
      quarantineRole = await guild.roles.create({
        name: 'Quarantined',
        color: 0xFF6B6B,
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: 'Izumi quarantine system setup'
      });
    } catch (e) {
      console.error('Error creating quarantine role:', e);
      return { success: false, error: 'Failed to create the Quarantined role. Check my role hierarchy.' };
    }
  }

  // Build a safe channel name from the username
  const safeName = ('quarantine-' + member.user.username.toLowerCase()
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20))
    || ('quarantine-' + member.user.id);

  // Find mod roles so they can see the private quarantine channel
  const modRoleOverwrites = guild.roles.cache
    .filter(r =>
      r.id !== guild.id &&
      r.id !== quarantineRole.id &&
      (r.permissions.has(PermissionFlagsBits.ModerateMembers) ||
       r.permissions.has(PermissionFlagsBits.BanMembers) ||
       r.permissions.has(PermissionFlagsBits.ManageGuild))
    )
    .map(r => ({
      id: r.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    }));

  // The permission set for the private channel:
  // - @everyone: denied
  // - Quarantined role: denied (so other quarantined users cannot see this channel)
  // - The specific user: explicitly allowed (user-specific overrides are highest priority in Discord)
  // - Bot: allowed with management permissions
  // - Any mod roles: allowed
  const channelOverwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: quarantineRole.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks]
    },
    ...modRoleOverwrites
  ];

  // Find an existing quarantine channel for this user (by stored ID or by name fallback)
  let quarantineChannel = null;
  const existingRecord = await QuarantinedUserModel.findOne({ guildId: guild.id, userId: member.id });
  if (existingRecord?.quarantineChannelId) {
    quarantineChannel = guild.channels.cache.get(existingRecord.quarantineChannelId) || null;
  }

  if (quarantineChannel) {
    // Reuse and patch the existing channel's overrides
    try {
      await quarantineChannel.permissionOverwrites.set(channelOverwrites);
    } catch (e) {
      console.warn('Could not patch existing quarantine channel overrides:', e.message);
    }
  } else {
    // Create a fresh private channel for this user
    try {
      quarantineChannel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        topic: `Private quarantine channel for ${member.user.tag}.`,
        permissionOverwrites: channelOverwrites
      });
    } catch (e) {
      console.error('Error creating quarantine channel:', e);
      return { success: false, error: 'Failed to create the quarantine channel. Check my permissions.' };
    }
  }

  // Save the user's current roles and the quarantine channel ID to MongoDB
  const savedRoleIds = member.roles.cache
    .filter(r => r.id !== guild.id)
    .map(r => r.id);

  await QuarantinedUserModel.findOneAndUpdate(
    { guildId: guild.id, userId: member.id },
    {
      guildId: guild.id, userId: member.id,
      savedRoles: savedRoleIds,
      quarantineChannelId: quarantineChannel.id,
      reason: reason || '',
      quarantinedBy: moderator?.tag || 'Automatic',
      quarantinedAt: new Date()
    },
    { upsert: true, new: true }
  ).catch(e => console.error('Failed to save quarantine record:', e));

  // Strip all manageable roles from the user (double-lock alongside the channel denies)
  const roleIdsToRemove = savedRoleIds.filter(id => {
    const role = guild.roles.cache.get(id);
    return role && botMember.roles.highest.comparePositionTo(role) > 0;
  });
  if (roleIdsToRemove.length > 0) {
    await member.roles.remove(roleIdsToRemove, 'Quarantine: stripping roles').catch(
      e => console.warn('Could not strip some roles during quarantine:', e.message)
    );
  }

  // Deny ViewChannel for the Quarantined role on every channel except the user's private channel
  for (const [, channel] of guild.channels.cache) {
    if (channel.id === quarantineChannel.id) continue;
    try {
      await channel.permissionOverwrites.edit(quarantineRole.id, { ViewChannel: false });
    } catch (e) {
      console.warn(`Could not deny ViewChannel on #${channel.name}: ${e.message}`);
    }
  }

  // Assign the Quarantined role
  try {
    await member.roles.add(quarantineRole, `Quarantined: ${reason}`);
  } catch (e) {
    console.error('Error adding quarantine role:', e);
    return { success: false, error: 'Failed to assign the Quarantined role. Check my role hierarchy.' };
  }

  const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));

  // DM the user
  try {
    const dmEmbed = new EmbedBuilder()
      .setTitle('You Have Been Quarantined')
      .setDescription(`You have been placed into quarantine in **${guild.name}**.\n\nYou have access to your own private quarantine channel. Only you and the moderation team can see it.`)
      .addFields(
        { name: 'Reason', value: reason || 'No reason provided', inline: false },
        { name: 'What to do', value: 'Please wait in your quarantine channel. A moderator will review your account shortly.', inline: false }
      )
      .setColor(0xFF6B6B)
      .setTimestamp();
    await member.send({ embeds: [dmEmbed] });
  } catch (e) { /* DMs may be closed */ }

  // Post a report inside the private quarantine channel
  const reportEmbed = new EmbedBuilder()
    .setTitle('User Quarantined')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription(`${member} — this is your private quarantine channel. Only you and the moderation team can see this. Please wait for a moderator to review your account.`)
    .addFields(
      { name: 'User', value: `${member.user.tag}\n\`${member.user.id}\``, inline: true },
      { name: 'Account Age', value: `${accountAgeDays} day${accountAgeDays !== 1 ? 's' : ''}`, inline: true },
      { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
      { name: 'Reason', value: reason || 'No reason provided', inline: false },
      { name: 'Actioned By', value: moderator ? `${moderator.tag}` : 'Izumi (Automatic)', inline: true },
      { name: 'Quarantined At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setColor(0xFF6B6B)
    .setFooter({ text: 'Use /allow to release this user from quarantine.' })
    .setTimestamp();

  try {
    await quarantineChannel.send({ content: `${member}`, embeds: [reportEmbed] });
  } catch (e) {
    console.error('Error sending quarantine channel message:', e);
  }

  return { success: true, quarantineChannel };
}

// Helper function to create channel selection menu
async function sendModLog(guild, embed) {
  const config = getServerConfig(guild.id);
  if (!config.modLogsChannel) return;
  const logChannel = guild.channels.cache.get(config.modLogsChannel);
  if (!logChannel) return;
  await logChannel.send({ embeds: [embed] }).catch(() => {});
}

function createChannelSelectMenu(guildId, logType) {
  const guild = client.guilds.cache.get(guildId);
  const textChannels = guild.channels.cache
    .filter(channel => channel.type === ChannelType.GuildText)
    .first(25); // Discord limit

  const options = textChannels.map(channel => ({
    label: `#${channel.name}`,
    value: channel.id,
    description: `Set as ${logType} logs channel`
  }));

  if (options.length === 0) {
    options.push({
      label: 'No text channels available',
      value: 'none',
      description: 'Create a text channel first'
    });
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`select_${logType}_logs_${guildId}`)
    .setPlaceholder(`Choose a channel for ${logType} logs`)
    .addOptions(options);
}

// Advanced mutual server analysis
async function analyzeMutualConnections(targetUser, requestingUser, client) {
  const mutualConnections = [];
  const suspiciousPatterns = [];

  try {
    // Get mutual guilds (limited by Discord API)
    const mutualGuilds = client.guilds.cache.filter(guild => {
      try {
        return guild.members.cache.has(targetUser.id) && guild.members.cache.has(requestingUser.id);
      } catch {
        return false;
      }
    });

    for (const [guildId, guild] of mutualGuilds) {
      try {
        const targetMember = await guild.members.fetch(targetUser.id);
        const requestingMember = await guild.members.fetch(requestingUser.id);

        // Analyze join timing patterns
        const joinTimeDiff = Math.abs(targetMember.joinedTimestamp - requestingMember.joinedTimestamp);
        const joinDiffHours = joinTimeDiff / (1000 * 60 * 60);

        const connectionData = {
          guildName: guild.name,
          guildId: guild.id,
          targetJoined: targetMember.joinedTimestamp,
          requestingUserJoined: requestingMember.joinedTimestamp,
          joinTimeDifference: joinDiffHours,
          targetRoles: targetMember.roles.cache.size - 1,
          bothHaveRoles: (targetMember.roles.cache.size > 1) && (requestingMember.roles.cache.size > 1)
        };

        mutualConnections.push(connectionData);

        // Detect suspicious patterns
        if (joinDiffHours < 24) {
          suspiciousPatterns.push(` Joined ${guild.name} within 24 hours of each other`);
        }

        if (joinDiffHours < 1) {
          suspiciousPatterns.push(` Joined ${guild.name} within 1 hour of each other`);
        }

      } catch (error) {
        // Skip if can't fetch members
      }
    }

    return {
      mutualCount: mutualConnections.length,
      connections: mutualConnections.slice(0, 5), // Limit to 5 for display
      suspiciousPatterns: suspiciousPatterns,
      hasCloseTimingPattern: suspiciousPatterns.some(p => p.includes('hour'))
    };

  } catch (error) {
    return {
      mutualCount: 0,
      connections: [],
      suspiciousPatterns: [' Unable to analyze mutual connections'],
      hasCloseTimingPattern: false
    };
  }
}

//  Bot login and slash command registration
client.once('ready', async () => {
  console.log(` Logged in as ${client.user.tag}`);

  await connectDB();
  await loadAllConfigs();
  await loadTicketConfigs();

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log(' Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log(' Slash commands registered successfully!');
  } catch (error) {
    console.error(' Error registering slash commands:', error);
  }
});

//  Message command handler with loading reactions
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.guild) {
    // Real-time activity tracking
    const today = new Date().toISOString().split('T')[0];
    const linkCount = (message.content.match(/(https?:\/\/[^\s]+)/g) || []).length;
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    ActivityLogModel.findOneAndUpdate(
      { guildId: message.guild.id, userId: message.author.id, date: today },
      { $inc: { messages: 1, links: linkCount, mentions: mentionCount }, $addToSet: { uniqueChannels: message.channel.id } },
      { upsert: true }
    ).catch(err => console.error('Activity log error:', err));

    // Trust score: track message activity
    MemberTrustModel.findOneAndUpdate(
      { guildId: message.guild.id, userId: message.author.id },
      { $inc: { messageCount: 1 }, $set: { lastActiveAt: new Date() } },
      { upsert: true, setDefaultsOnInsert: true }
    ).catch(err => console.error('Trust log error:', err));

    // Suspicious mention velocity detection
    if (message.mentions.users.size > 0) {
      (async () => {
        try {
          const trackKey = `${message.guild.id}_${message.author.id}`;
          const now = Date.now();
          const windowStart = now - MENTION_WINDOW_MS;

          let tracked = mentionTracker.get(trackKey) || [];
          tracked = tracked.filter(m => m.timestamp > windowStart);

          for (const [id, user] of message.mentions.users) {
            if (id === message.author.id || user.bot) continue;
            if (!tracked.some(m => m.mentionedId === id)) {
              tracked.push({ mentionedId: id, timestamp: now });
            }
          }
          mentionTracker.set(trackKey, tracked);

          const uniqueCount = new Set(tracked.map(m => m.mentionedId)).size;
          if (uniqueCount >= MENTION_ALERT_THRESHOLD) {
            const trustData = await MemberTrustModel.findOne({ guildId: message.guild.id, userId: message.author.id });
            const trust = calculateTrustScore(message.member, trustData);
            if (trust.score < 60) {
              const config = await ServerConfigModel.findOne({ guildId: message.guild.id });
              if (config?.modLogsChannel) {
                const alertChannel = message.guild.channels.cache.get(config.modLogsChannel);
                if (alertChannel) {
                  const alertEmbed = new EmbedBuilder()
                    .setTitle('Suspicious Mention Velocity')
                    .setColor(0xFF4444)
                    .setDescription(`A low-trust member has rapidly mentioned **${uniqueCount} unique users** within the last 10 minutes. This may indicate phishing or mass DM solicitation.`)
                    .addFields(
                      { name: 'User', value: `${message.author.tag}\n\`${message.author.id}\``, inline: true },
                      { name: 'Trust Score', value: `${trust.label} (${trust.score}/100)`, inline: true },
                      { name: 'Unique Users Mentioned', value: `${uniqueCount} in last 10 min`, inline: true },
                      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                      { name: 'Message', value: `[Jump to message](${message.url})`, inline: true }
                    )
                    .setFooter({ text: 'Izumi  •  Mention Velocity Monitor' })
                    .setTimestamp();
                  await alertChannel.send({ embeds: [alertEmbed] }).catch(console.error);
                  // Reset tracker so alert doesn't fire again until next threshold breach
                  mentionTracker.set(trackKey, []);
                }
              }
            }
          }
        } catch (err) {
          console.error('Mention tracker error:', err);
        }
      })();
    }

    // Advanced content restriction enforcement
    const handled = await checkAdvancedRestrictions(message);
    if (handled) return;

  }

  // Status auto-reply when the bot owner is mentioned
  const ownerId = '1299875574894039184';
  if (message.mentions.users.has(ownerId)) {
    try {
      // Ensure we have the member and their presence cached
      let member = message.guild.members.cache.get(ownerId);
      if (!member || !member.presence) {
        member = await message.guild.members.fetch({ user: ownerId, withPresences: true }).catch(() => null);
      }

      const status = member?.presence?.status || 'offline';

      if (status === 'online' || status === 'idle') return;

      const offlineReplies = [
        `Hm? My owner is currently offline — they'll get back to you when they're around.`,
        `My owner's gone dark. No ETA on when they'll resurface.`,
        `Offline. Whatever you need, it's going to have to wait.`,
        `My owner isn't here right now. Leave a message and maybe they'll see it eventually.`,
        `They're offline. I'd pass the message along, but I'm a bot, not a secretary.`,
        `Not here. Try again later, or just... wait. Waiting works too.`,
        `My owner has logged off from reality for the time being.`,
        `Offline. Whether they'll be back soon is anyone's guess, honestly.`,
        `Can't reach them right now. They're somewhere without a screen, presumably.`,
        `My owner is offline. Your ping has been noted and will be ignored until further notice.`,
      ];

      const dndReplies = [
        `Do Not Disturb. The name kind of says it all, doesn't it?`,
        `My owner is on Do Not Disturb. Whatever it is, it can wait.`,
        `DND is on. They've seen enough for now.`,
        `My owner would like to not be disturbed. Please respect that.`,
        `Do Not Disturb mode. They're busy, or just need a break. Either way, not now.`,
        `They set that status for a reason. Try again later.`,
        `DND. They know you're there. They're just choosing not to engage right now.`,
        `My owner is in Do Not Disturb. Even I'm not interrupting them.`,
        `Not available. The DND status wasn't decorative.`,
        `Do Not Disturb means exactly that. They'll come back when they're ready.`,
      ];

      const pool = status === 'dnd' ? dndReplies : offlineReplies;
      const reply = pool[Math.floor(Math.random() * pool.length)];

      await message.reply(reply).catch(console.error);
    } catch (err) {
      console.error('Error in owner mention reply:', err);
    }
  }

  // Handle !riskreport command
  if (message.content.startsWith('!riskreport')) {
    if (!isModerator(message.member)) {
      return message.reply('You need moderator permissions to use this command.');
    }

    try {
      const report = await generateServerRiskReport(message.guild, message.author);
      const embed = await createRiskReportEmbed(report, message.guild);
      return message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error generating risk report:', error);
      return message.reply('Error generating server risk report. Please try again.');
    }
  }

  // Handle !behavioursummary command
  if (message.content.startsWith('!behavioursummary')) {
    if (!isModerator(message.member)) {
      return message.reply('You need moderator permissions to use this command.');
    }

    const args = message.content.split(' ').slice(1);
    let target;

    if (message.mentions.users.size > 0) {
      target = message.mentions.users.first();
    } else if (args[0]) {
      try {
        target = await client.users.fetch(args[0]);
      } catch {
        return message.reply('Could not find a user with that ID.');
      }
    }

    if (!target) {
      return message.reply('Please mention a user or provide a valid user ID.');
    }

    try {
      const activityData = await getActivityData(message.guild.id, target.id, 14);
      const { embed, components } = buildActivityEmbed(target, 14, activityData);
      return message.reply({ embeds: [embed], components });
    } catch (error) {
      console.error('Error generating behaviour summary:', error);
      return message.reply('Error generating behaviour summary. Please try again.');
    }
  }

  // =dsnipe — show last deleted message in this channel
  if (message.content.trim() === '=dsnipe') {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('You need the **Manage Messages** permission to use this command.');
    }
    const entry = snipeDeleteCache.get(message.channel.id);
    if (!entry) {
      return message.reply('There is nothing to snipe in this channel.');
    }
    const embed = new EmbedBuilder()
      .setTitle('Message Deleted')
      .setColor(0xFF0000)
      .addFields(
        { name: 'Author', value: `${entry.author.tag} (${entry.author.id})`, inline: true },
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Deleted At', value: `<t:${Math.floor(entry.deletedAt / 1000)}:F>`, inline: true }
      )
      .setTimestamp();
    if (entry.content) {
      embed.addFields({
        name: 'Content',
        value: entry.content.length > 1024 ? `${entry.content.substring(0, 1021)}...` : entry.content,
        inline: false
      });
    }
    if (entry.attachments.length > 0) {
      const list = entry.attachments.map(a => `[${a.name}](${a.url})`).join('\n');
      embed.addFields({
        name: 'Attachments',
        value: list.length > 1024 ? `${list.substring(0, 1021)}...` : list,
        inline: false
      });
    }
    embed.setFooter({ text: `Sniped by ${message.author.tag}` });
    return message.reply({ embeds: [embed] });
  }

  // =esnipe — show last edited message in this channel
  if (message.content.trim() === '=esnipe') {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('You need the **Manage Messages** permission to use this command.');
    }
    const entry = snipeEditCache.get(message.channel.id);
    if (!entry) {
      return message.reply('There is nothing to snipe in this channel.');
    }
    const embed = new EmbedBuilder()
      .setTitle('Message Edited')
      .setColor(0xFFA500)
      .addFields(
        { name: 'Author', value: `${entry.author.tag} (${entry.author.id})`, inline: true },
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Edited At', value: `<t:${Math.floor(entry.editedAt / 1000)}:F>`, inline: true }
      )
      .setTimestamp();
    if (entry.before) {
      embed.addFields({
        name: 'Before',
        value: entry.before.length > 512 ? `${entry.before.substring(0, 509)}...` : entry.before,
        inline: false
      });
    }
    if (entry.after) {
      embed.addFields({
        name: 'After',
        value: entry.after.length > 512 ? `${entry.after.substring(0, 509)}...` : entry.after,
        inline: false
      });
    }
    embed.addFields({ name: 'Jump to Message', value: `[Click here](${entry.messageUrl})`, inline: true });
    embed.setFooter({ text: `Sniped by ${message.author.tag}` });
    return message.reply({ embeds: [embed] });
  }

  // =rsnipe — show last removed reaction in this channel
  if (message.content.trim() === '=rsnipe') {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('You need the **Manage Messages** permission to use this command.');
    }
    const entry = snipeReactionCache.get(message.channel.id);
    if (!entry) {
      return message.reply('There is nothing to snipe in this channel.');
    }
    const embed = new EmbedBuilder()
      .setTitle('Reaction Removed')
      .setColor(0xFF4444)
      .addFields(
        { name: 'User', value: `${entry.user.tag} (${entry.user.id})`, inline: true },
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Removed At', value: `<t:${Math.floor(entry.removedAt / 1000)}:F>`, inline: true },
        { name: 'Reaction', value: `${entry.emoji}`, inline: true },
        { name: 'Message', value: `[Jump to message](${entry.messageUrl})`, inline: true }
      )
      .setTimestamp();
    if (entry.messageContent) {
      const c = entry.messageContent.length > 200 ? `${entry.messageContent.substring(0, 197)}...` : entry.messageContent;
      embed.addFields({ name: 'Message Content', value: c, inline: false });
    }
    embed.setFooter({ text: `Message author: ${entry.messageAuthorTag} | Sniped by ${message.author.tag}` });
    return message.reply({ embeds: [embed] });
  }

  if (!message.content.startsWith('!check')) return;

  if (!isModerator(message.member)) {
    return message.reply('You need moderator permissions to use this command.');
  }

  const args = message.content.split(' ').slice(1);
  let target;

  if (message.mentions.users.size > 0) {
    target = message.mentions.users.first();
  } else if (args[0]) {
    try {
      target = await client.users.fetch(args[0]);
    } catch {
      return message.reply('Could not find a user with that ID.');
    }
  }

  if (!target) {
    return message.reply('Please mention a user or provide a valid user ID.');
  }

  const risk = await calculateRisk(target, message.guild);

  // Add mutual server analysis
  const mutualAnalysis = await analyzeMutualConnections(target, message.author, client);
  risk.mutualAnalysis = mutualAnalysis;

  // Apply mutual server risk scoring
  if (mutualAnalysis.hasCloseTimingPattern) {
    risk.score += 25;
    risk.factors.push('Suspicious mutual server timing patterns');
  }
  if (mutualAnalysis.mutualCount === 0) {
    risk.score += 5;
    risk.factors.push('No detectable mutual servers');
  }

  // Recalculate risk label after mutual analysis
  risk.score = Math.max(0, Math.min(100, risk.score));
  if (risk.score >= 80) risk.label = 'Critical';
  else if (risk.score >= 60) risk.label = 'High';
  else if (risk.score >= 35) risk.label = 'Medium';
  else if (risk.score >= 15) risk.label = 'Low';
  else risk.label = 'Minimal';

  const embed = await makeCheckEmbed(target, risk, message.guild);

  // Check if target is admin (immune to moderation)
  const targetMember = await message.guild.members.fetch(target.id).catch(() => null);
  const isTargetAdmin = targetMember && isAdmin(targetMember);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`kick_${target.id}`)
      .setLabel(isTargetAdmin ? 'Kick (Admin Immune)' : 'Kick')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin),
    new ButtonBuilder()
      .setCustomId(`ban_${target.id}`)
      .setLabel(isTargetAdmin ? 'Ban (Admin Immune)' : 'Ban')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isTargetAdmin)
  );

  return message.reply({ embeds: [embed], components: [buttons] });
});

//  Slash command handler
client.on('interactionCreate', async interaction => {
  try {
    const ticketHandled = await handleTicketInteraction(interaction);
    if (ticketHandled) return;

    if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'check') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      const target = interaction.options.getUser('user');
      const risk = await calculateRisk(target, interaction.guild);

      // Add mutual server analysis
      const mutualAnalysis = await analyzeMutualConnections(target, interaction.user, client);
      risk.mutualAnalysis = mutualAnalysis;

      // Apply mutual server risk scoring
      if (mutualAnalysis.hasCloseTimingPattern) {
        risk.score += 25;
        risk.factors.push(' Suspicious mutual server timing patterns');
      }
      if (mutualAnalysis.mutualCount === 0) {
        risk.score += 5;
        risk.factors.push(' No detectable mutual servers');
      }

      // Recalculate risk label after mutual analysis
      risk.score = Math.max(0, Math.min(100, risk.score));
      if (risk.score >= 80) risk.label = 'Critical';
      else if (risk.score >= 60) risk.label = 'High';
      else if (risk.score >= 35) risk.label = 'Medium';
      else if (risk.score >= 15) risk.label = 'Low';
      else risk.label = 'Minimal';

      const embed = await makeCheckEmbed(target, risk, interaction.guild);

      const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
      const isTargetAdmin = targetMember && isAdmin(targetMember);

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`allow_${target.id}`).setLabel('Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`kick_${target.id}`)
          .setLabel(isTargetAdmin ? 'Kick (Admin Immune)' : 'Kick')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin),
        new ButtonBuilder()
          .setCustomId(`ban_${target.id}`)
          .setLabel(isTargetAdmin ? 'Ban (Admin Immune)' : 'Ban')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(isTargetAdmin)
      );

      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    if (commandName === 'purge') {
      const scope = interaction.options.getString('scope');
      const targetUser = interaction.options.getUser('user');
      const targetIdRaw = interaction.options.getString('userid');
      const hardLimit = interaction.options.getInteger('limit') ?? Infinity;

      // Resolve target
      let targetId = null;
      let targetTag = null;
      if (targetIdRaw) {
        if (!/^\d{17,20}$/.test(targetIdRaw.trim())) {
          return interaction.reply({ content: 'That doesn\'t look like a valid user ID.', ephemeral: true });
        }
        targetId = targetIdRaw.trim();
        try { const u = await client.users.fetch(targetId); targetTag = u.tag; }
        catch { targetTag = `Unknown User (${targetId})`; }
      } else if (targetUser) {
        targetId = targetUser.id;
        targetTag = targetUser.tag;
      }

      await interaction.deferReply();

      // Easter egg — GIF embed shown while working
      const purgeGif = new AttachmentBuilder(path.join(__dirname, 'IMG_6957.gif'), { name: 'IMG_6957.gif' });
      const workingEmbed = new EmbedBuilder()
        .setTitle('Purging messages...')
        .setDescription(targetId
          ? `Scanning for messages sent by **${targetTag}**. This may take a moment.`
          : 'Indiscriminate deletion in progress. Stand clear.')
        .setImage('attachment://IMG_6957.gif')
        .setColor(0xFF6B35)
        .setFooter({ text: 'Izumi is on the case.' });

      await interaction.editReply({ embeds: [workingEmbed], files: [purgeGif] });

      const startTime = Date.now();
      const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      let totalDeleted = 0;
      let totalSkipped = 0;
      const channelsAffected = [];

      const purgeChannel = async (channel) => {
        let channelDeleted = 0;
        let lastId = null;

        while (totalDeleted + channelDeleted < hardLimit) {
          const batchSize = Math.min(100, hardLimit - (totalDeleted + channelDeleted));
          const fetchOptions = { limit: batchSize };
          if (lastId) fetchOptions.before = lastId;

          const fetched = await channel.messages.fetch(fetchOptions).catch(() => null);
          if (!fetched || fetched.size === 0) break;

          const candidates = targetId ? fetched.filter(m => m.author.id === targetId) : fetched;
          const recent = candidates.filter(m => m.createdTimestamp > twoWeeksAgo);
          totalSkipped += candidates.filter(m => m.createdTimestamp <= twoWeeksAgo).size;

          if (recent.size > 0) {
            const deleted = await channel.bulkDelete(recent, true).catch(() => ({ size: 0 }));
            channelDeleted += deleted.size;
          }

          lastId = fetched.last().id;
          if (fetched.last().createdTimestamp <= twoWeeksAgo) break;
        }

        if (channelDeleted > 0) channelsAffected.push({ channel, count: channelDeleted });
        totalDeleted += channelDeleted;
      };

      try {
        if (scope === 'channel') {
          await purgeChannel(interaction.channel);
        } else {
          const botMember = interaction.guild.members.me;
          const textChannels = interaction.guild.channels.cache.filter(c =>
            c.type === ChannelType.GuildText &&
            c.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)
          );
          for (const [, ch] of textChannels) {
            if (totalDeleted >= hardLimit) break;
            await purgeChannel(ch);
          }
        }
      } catch (err) {
        console.error('Purge error:', err);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      const completionEmbed = new EmbedBuilder()
        .setTitle(`**${totalDeleted} message${totalDeleted !== 1 ? 's' : ''} successfully purged**`)
        .setColor(totalDeleted > 0 ? 0x00C853 : 0xFFA500)
        .addFields(
          { name: 'Executed By', value: `${interaction.user.tag}\n(${interaction.user.id})`, inline: true },
          { name: 'Scope', value: scope === 'channel' ? `<#${interaction.channel.id}>` : 'Server-wide', inline: true },
          { name: 'Duration', value: `${duration}s`, inline: true },
          { name: 'Started', value: `<t:${Math.floor(startTime / 1000)}:T>`, inline: true },
          { name: 'Completed', value: `<t:${Math.floor(Date.now() / 1000)}:T>`, inline: true },
          { name: 'Limit Applied', value: hardLimit === Infinity ? 'None (all available)' : `${hardLimit} messages`, inline: true }
        );

      if (targetId) {
        completionEmbed.addFields({ name: 'Target', value: `${targetTag}\n(${targetId})`, inline: false });
      } else {
        completionEmbed.addFields({ name: 'Target', value: 'All users — indiscriminate deletion', inline: false });
      }

      if (scope === 'server' && channelsAffected.length > 0) {
        const chList = channelsAffected.map(c => `<#${c.channel.id}> — ${c.count} deleted`).join('\n');
        completionEmbed.addFields({
          name: `Channels Affected (${channelsAffected.length})`,
          value: chList.length > 1024 ? chList.substring(0, 1021) + '...' : chList,
          inline: false
        });
      }

      if (totalSkipped > 0) {
        completionEmbed.addFields({
          name: 'Skipped',
          value: `${totalSkipped} message${totalSkipped !== 1 ? 's were' : ' was'} older than 14 days and cannot be bulk-deleted due to Discord's API limit.`,
          inline: false
        });
      }

      if (totalDeleted === 0) {
        completionEmbed.setDescription('No deletable messages were found matching your criteria within Discord\'s 14-day window.');
      }

      completionEmbed.setTimestamp();
      return interaction.editReply({ embeds: [completionEmbed] });
    }

    if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      const owner = await guild.fetchOwner();

      const embed = new EmbedBuilder()
        .setTitle(` Server Information: ${guild.name}`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .addFields(
          { name: ' Owner', value: owner.user.tag, inline: true },
          { name: ' Members', value: guild.memberCount.toString(), inline: true },
          { name: ' Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: ' Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: ' Channels', value: guild.channels.cache.size.toString(), inline: true },
          { name: ' Emojis', value: guild.emojis.cache.size.toString(), inline: true }
        )
        .setColor(0x5865F2)
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle(` User Information: ${target.tag}`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: ' ID', value: target.id, inline: true },
          { name: ' Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
          { name: ' Bot', value: target.bot ? 'Yes' : 'No', inline: true }
        )
        .setColor(target.accentColor || 0x5865F2)
        .setTimestamp();

      if (member) {
        embed.addFields(
          { name: ' Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`, inline: true },
          { name: ' Roles', value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(', ') || 'None', inline: false }
        );

        if (member.premiumSince) {
          embed.addFields({ name: ' Boosting Since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:D>`, inline: true });
        }
      }

      return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'searchuser') {
      const rawId = interaction.options.getString('userid').trim();

      if (!/^\d{17,20}$/.test(rawId)) {
        return interaction.reply({ content: 'That doesn\'t look like a valid Discord user ID. IDs are 17–20 digit numbers.', ephemeral: true });
      }

      await interaction.deferReply();

      let target;
      try {
        target = await client.users.fetch(rawId, { force: true });
      } catch {
        return interaction.editReply({ content: `No user found with ID \`${rawId}\`. They may not exist or the ID is incorrect.` });
      }

      const member = await interaction.guild.members.fetch(rawId).catch(() => null);
      const accountAgeDays = Math.floor((Date.now() - target.createdTimestamp) / (1000 * 60 * 60 * 24));
      const accountAgeYears = (accountAgeDays / 365).toFixed(1);

      // Resolve badges
      const flagMap = {
        Staff:                    'Discord Staff',
        Partner:                  'Partnered Server Owner',
        Hypesquad:                'HypeSquad Events',
        BugHunterLevel1:          'Bug Hunter',
        BugHunterLevel2:          'Bug Hunter Gold',
        HypeSquadOnlineHouse1:    'HypeSquad Bravery',
        HypeSquadOnlineHouse2:    'HypeSquad Brilliance',
        HypeSquadOnlineHouse3:    'HypeSquad Balance',
        PremiumEarlySupporter:    'Early Supporter',
        TeamPseudoUser:           'Team User',
        VerifiedBot:              'Verified Bot',
        VerifiedDeveloper:        'Verified Bot Developer',
        CertifiedModerator:       'Certified Moderator',
        ActiveDeveloper:          'Active Developer',
      };
      const badges = target.flags
        ? target.flags.toArray().map(f => flagMap[f] || f).join('\n') || 'None'
        : 'None';

      // Nitro indicators
      const nitroSigns = [];
      if (target.avatar?.startsWith('a_')) nitroSigns.push('Animated avatar');
      if (target.banner) nitroSigns.push('Custom profile banner');
      if (member?.premiumSince) nitroSigns.push('Active server booster');

      // Quick risk snapshot
      const risk = await calculateRisk(target, interaction.guild);
      const riskColors = { Critical: 0x8B0000, High: 0xFF0000, Medium: 0xFFA500, Low: 0xFFFF00, Minimal: 0x00FF00 };
      const embedColor = riskColors[risk.label] || 0x5865F2;

      // Trust score
      const trustData = member ? await MemberTrustModel.findOne({ guildId: interaction.guild.id, userId: target.id }) : null;
      const trust = member ? calculateTrustScore(member, trustData) : null;

      // Permission level in this server
      let permLevel = 'Not in server';
      if (member) {
        if (member.permissions.has('Administrator')) permLevel = 'Administrator';
        else if (member.permissions.has('ManageGuild')) permLevel = 'Manager';
        else if (member.permissions.has('ModerateMembers')) permLevel = 'Moderator';
        else permLevel = 'Member';
      }

      const embed = new EmbedBuilder()
        .setTitle(`User Profile: ${target.username}`)
        .setDescription(
          `${target.bot ? '**This account is a bot.**\n' : ''}` +
          `${target.globalName && target.globalName !== target.username ? `**Display Name:** ${target.globalName}\n` : ''}` +
          `**User Tag:** ${target.tag}`
        )
        .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 512 }))
        .setColor(embedColor)
        .addFields(
          { name: 'User ID', value: `\`${target.id}\``, inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>\n(<t:${Math.floor(target.createdTimestamp / 1000)}:R>)`, inline: true },
          { name: 'Account Age', value: `${accountAgeDays} days (${accountAgeYears} yrs)`, inline: true }
        )
        .addFields(
          { name: 'Badges', value: badges, inline: true },
          { name: 'Nitro Signs', value: nitroSigns.length > 0 ? nitroSigns.join('\n') : 'None detected', inline: true },
          { name: 'Risk Snapshot', value: `**${risk.label}** (${risk.score}/100)`, inline: true }
        )
        .addFields(
          { name: 'Trust Score', value: trust ? `**${trust.label}** (${trust.score}/100)` : 'Not in server', inline: true }
        );

      if (member) {
        const roles = member.roles.cache
          .filter(r => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position)
          .map(r => `<@&${r.id}>`)
          .slice(0, 10)
          .join(' ') || 'None';

        embed.addFields(
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>\n(<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`, inline: true },
          { name: 'Permission Level', value: permLevel, inline: true },
          { name: 'Timed Out', value: member.communicationDisabledUntil && member.communicationDisabledUntil > Date.now() ? `Until <t:${Math.floor(member.communicationDisabledUntil / 1000)}:R>` : 'No', inline: true },
          { name: `Roles (${member.roles.cache.size - 1})`, value: roles, inline: false }
        );

        if (member.premiumSince) {
          embed.addFields({ name: 'Boosting Since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:D>`, inline: true });
        }
      } else {
        embed.addFields({ name: 'Server Status', value: 'This user is **not** in this server.', inline: false });
      }

      if (target.banner) {
        embed.setImage(target.bannerURL({ dynamic: true, size: 1024 }));
        embed.addFields({ name: 'Profile Banner', value: 'Shown below', inline: true });
      }

      embed.setFooter({ text: `Searched by ${interaction.user.tag}  •  User ID: ${target.id}` }).setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`check_from_search_${target.id}`)
          .setLabel('Run Full Risk Check')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setLabel('Open Avatar')
          .setStyle(ButtonStyle.Link)
          .setURL(target.displayAvatarURL({ dynamic: true, size: 1024 })),
        ...(target.banner ? [
          new ButtonBuilder()
            .setLabel('Open Banner')
            .setStyle(ButtonStyle.Link)
            .setURL(target.bannerURL({ dynamic: true, size: 1024 }))
        ] : [])
      );

      return interaction.editReply({ embeds: [embed], components: [buttons] });
    }

    if (commandName === 'trust') {
      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      }

      await interaction.deferReply();

      const trustData = await MemberTrustModel.findOne({ guildId: interaction.guild.id, userId: target.id });
      const trust = calculateTrustScore(member, trustData);

      const accountAgeDays = Math.floor((Date.now() - target.createdTimestamp) / 86400000);
      const joinDays = Math.floor((Date.now() - member.joinedTimestamp) / 86400000);

      const trustBar = (() => {
        const filled = Math.round(trust.score / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${trust.score}/100`;
      })();

      const breakdownLines = [];
      breakdownLines.push(`Account age: ${accountAgeDays} days`);
      breakdownLines.push(`In server: ${joinDays} days`);
      breakdownLines.push(`Messages tracked: ${trustData?.messageCount ?? 0}`);
      if (member.premiumSince) breakdownLines.push('Server booster');
      const roleCount = member.roles.cache.size - 1;
      if (roleCount >= 3) breakdownLines.push(`Has ${roleCount} roles`);
      if (trustData?.warningCount) breakdownLines.push(`Warnings: ${trustData.warningCount}`);
      if (trustData?.flagCount) breakdownLines.push(`Alt/risk flags: ${trustData.flagCount}`);
      if (trustData?.quarantineCount) breakdownLines.push(`Quarantine history: ${trustData.quarantineCount}`);

      const embed = new EmbedBuilder()
        .setTitle(`Trust Score: ${target.username}`)
        .setColor(trust.color)
        .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'Verdict', value: `**${trust.label}**`, inline: true },
          { name: 'Score', value: trustBar, inline: false },
          { name: 'Score Breakdown', value: breakdownLines.join('\n'), inline: false }
        )
        .setFooter({ text: `Checked by ${interaction.user.tag}  •  Izumi Trust System` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'warn') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot warn yourself.', ephemeral: true });

      await interaction.deferReply();

      const warnId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      await WarnModel.create({
        guildId: interaction.guild.id,
        userId: target.id,
        warnedBy: interaction.user.id,
        reason,
        warnId
      });

      await MemberTrustModel.findOneAndUpdate(
        { guildId: interaction.guild.id, userId: target.id },
        { $inc: { warningCount: 1 } },
        { upsert: true, setDefaultsOnInsert: true }
      );

      const totalWarnings = await WarnModel.countDocuments({ guildId: interaction.guild.id, userId: target.id });

      const warnEmbed = new EmbedBuilder()
        .setTitle('Warning Issued')
        .setColor(0xFFD600)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: 'Member', value: `${target.tag}\n\`${target.id}\``, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
          { name: 'Total Warnings', value: `${totalWarnings}`, inline: true },
          { name: 'Reason', value: reason, inline: false },
          { name: 'Warning ID', value: `\`${warnId}\``, inline: false }
        )
        .setTimestamp();

      await sendModLog(interaction.guild, warnEmbed);

      const dmEmbed = new EmbedBuilder()
        .setTitle(`You have received a warning in ${interaction.guild.name}`)
        .setColor(0xFFD600)
        .addFields(
          { name: 'Reason', value: reason, inline: false },
          { name: 'Issued by', value: interaction.user.tag, inline: true },
          { name: 'Total Warnings', value: `${totalWarnings}`, inline: true }
        )
        .setTimestamp();

      await target.send({ embeds: [dmEmbed] }).catch(() => {});

      return interaction.editReply({ embeds: [warnEmbed] });
    }

    if (commandName === 'warnings') {
      const target = interaction.options.getUser('user');
      await interaction.deferReply();

      const warns = await WarnModel.find({ guildId: interaction.guild.id, userId: target.id }).sort({ timestamp: -1 });

      if (warns.length === 0) {
        return interaction.editReply({ content: `**${target.tag}** has no warnings on record.` });
      }

      const warnLines = warns.map((w, i) => {
        const mod = `<@${w.warnedBy}>`;
        const time = `<t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:D>`;
        return `**${i + 1}.** \`${w.warnId}\` — ${w.reason}\n    by ${mod} on ${time}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setTitle(`Warnings: ${target.tag}`)
        .setColor(0xFFD600)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setDescription(warnLines.slice(0, 4000))
        .setFooter({ text: `${warns.length} warning${warns.length !== 1 ? 's' : ''} total  •  Use /clearwarn <id> to remove one` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'clearwarn') {
      const warnId = interaction.options.getString('warnid').trim();
      await interaction.deferReply({ ephemeral: true });

      const warn = await WarnModel.findOneAndDelete({ guildId: interaction.guild.id, warnId });

      if (!warn) {
        return interaction.editReply({ content: `No warning found with ID \`${warnId}\` in this server.` });
      }

      await MemberTrustModel.findOneAndUpdate(
        { guildId: interaction.guild.id, userId: warn.userId },
        [{ $set: { warningCount: { $max: [0, { $subtract: ['$warningCount', 1] }] } } }]
      );

      const remaining = await WarnModel.countDocuments({ guildId: interaction.guild.id, userId: warn.userId });

      return interaction.editReply({
        content: `Warning \`${warnId}\` removed. <@${warn.userId}> now has **${remaining}** warning${remaining !== 1 ? 's' : ''} remaining.`
      });
    }

    if (commandName === 'clearwarnings') {
      const target = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });

      const result = await WarnModel.deleteMany({ guildId: interaction.guild.id, userId: target.id });

      if (result.deletedCount === 0) {
        return interaction.editReply({ content: `**${target.tag}** has no warnings to clear.` });
      }

      await MemberTrustModel.findOneAndUpdate(
        { guildId: interaction.guild.id, userId: target.id },
        { $set: { warningCount: 0 } }
      );

      return interaction.editReply({
        content: `Cleared **${result.deletedCount}** warning${result.deletedCount !== 1 ? 's' : ''} from **${target.tag}**. Their trust score will reflect this.`
      });
    }

    if (commandName === 'watch') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (target.id === interaction.user.id) return interaction.reply({ content: 'You cannot watch yourself.', ephemeral: true });
      if (target.bot) return interaction.reply({ content: 'You cannot watch a bot.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      await WatchlistModel.findOneAndUpdate(
        { guildId: interaction.guild.id, userId: target.id },
        { guildId: interaction.guild.id, userId: target.id, addedBy: interaction.user.id, reason, addedAt: new Date() },
        { upsert: true, new: true }
      );

      if (!watchlistCache.has(interaction.guild.id)) watchlistCache.set(interaction.guild.id, new Set());
      watchlistCache.get(interaction.guild.id).add(target.id);

      return interaction.editReply({
        content: `**${target.tag}** is now being watched. Their deleted messages, edits, and reactions will be automatically logged.`
      });
    }

    if (commandName === 'unwatch') {
      const target = interaction.options.getUser('user');
      await interaction.deferReply({ ephemeral: true });

      const result = await WatchlistModel.deleteOne({ guildId: interaction.guild.id, userId: target.id });

      if (result.deletedCount === 0) {
        return interaction.editReply({ content: `**${target.tag}** is not on the watchlist.` });
      }

      if (watchlistCache.has(interaction.guild.id)) watchlistCache.get(interaction.guild.id).delete(target.id);

      return interaction.editReply({ content: `**${target.tag}** has been removed from the watchlist.` });
    }

    if (commandName === 'watchlist') {
      await interaction.deferReply();

      const watches = await WatchlistModel.find({ guildId: interaction.guild.id }).sort({ addedAt: -1 });

      if (watches.length === 0) {
        return interaction.editReply({ content: 'No users are currently being watched in this server.' });
      }

      const lines = watches.map((w, i) => {
        const time = `<t:${Math.floor(new Date(w.addedAt).getTime() / 1000)}:R>`;
        return `**${i + 1}.** <@${w.userId}> \`${w.userId}\`\n    Added by <@${w.addedBy}> ${time}\n    Reason: ${w.reason}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setTitle(`Watchlist — ${interaction.guild.name}`)
        .setColor(0xFF6B35)
        .setDescription(lines.slice(0, 4000))
        .setFooter({ text: `${watches.length} user${watches.length !== 1 ? 's' : ''} under observation` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'setwatchlog') {
      const channel = interaction.options.getChannel('channel');
      await interaction.deferReply({ ephemeral: true });

      await ServerConfigModel.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { watchLogChannel: channel.id } },
        { upsert: true }
      );

      const cfg = getServerConfig(interaction.guild.id);
      cfg.watchLogChannel = channel.id;

      return interaction.editReply({ content: `Watch logs for edits and reactions will now be posted in ${channel}.` });
    }

    if (commandName === 'kick') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      if (isAdmin(member)) return interaction.reply({ content: 'That member has administrator privileges and cannot be kicked.', ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: 'I do not have permission to kick that member. Check my role position.', ephemeral: true });

      await member.kick(reason);
      const kickEmbed = new EmbedBuilder()
        .setTitle('Member Kicked')
        .setColor(0xFF6B35)
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setTimestamp();
      await sendModLog(interaction.guild, kickEmbed);
      return interaction.reply({ embeds: [kickEmbed] });
    }

    if (commandName === 'ban') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (member) {
        if (isAdmin(member)) return interaction.reply({ content: 'That member has administrator privileges and cannot be banned.', ephemeral: true });
        if (!member.bannable) return interaction.reply({ content: 'I do not have permission to ban that member. Check my role position.', ephemeral: true });
      }

      await interaction.guild.bans.create(target.id, { reason, deleteMessageDays: deleteDays });
      const banEmbed = new EmbedBuilder()
        .setTitle('Member Banned')
        .setColor(0xFF0000)
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setTimestamp();
      await sendModLog(interaction.guild, banEmbed);
      return interaction.reply({ embeds: [banEmbed] });
    }

    if (commandName === 'timeout') {
      const target = interaction.options.getUser('user');
      const durationSeconds = parseInt(interaction.options.getString('duration'));
      const reason = interaction.options.getString('reason') || 'No reason provided';
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      if (isAdmin(member)) return interaction.reply({ content: 'That member has administrator privileges and cannot be timed out.', ephemeral: true });
      if (!member.moderatable) return interaction.reply({ content: 'I do not have permission to timeout that member. Check my role position.', ephemeral: true });

      const until = Date.now() + durationSeconds * 1000;
      await member.timeout(durationSeconds * 1000, reason);

      const durationLabel = durationSeconds === 60 ? '60 seconds'
        : durationSeconds === 300 ? '5 minutes'
        : durationSeconds === 600 ? '10 minutes'
        : durationSeconds === 1800 ? '30 minutes'
        : durationSeconds === 3600 ? '1 hour'
        : durationSeconds === 21600 ? '6 hours'
        : durationSeconds === 43200 ? '12 hours'
        : durationSeconds === 86400 ? '1 day'
        : '1 week';

      const timeoutEmbed = new EmbedBuilder()
        .setTitle('Member Timed Out')
        .setColor(0xFFA500)
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: 'Duration', value: durationLabel, inline: true },
          { name: 'Expires', value: `<t:${Math.floor(until / 1000)}:R>`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setTimestamp();
      await sendModLog(interaction.guild, timeoutEmbed);
      return interaction.reply({ embeds: [timeoutEmbed] });
    }

    if (commandName === 'althistory') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      const limit = interaction.options.getInteger('limit') || 5;

      // This is a placeholder - in a real implementation you'd store check history in a database
      const embed = new EmbedBuilder()
        .setTitle('Recent Alt Account Checks')
        .setDescription('This feature requires a database to store check history. Currently showing placeholder data.')
        .addFields(
          { name: 'Last 24 Hours', value: 'No checks recorded', inline: false },
          { name: 'Total Checks', value: 'Database not configured', inline: true },
          { name: 'High Risk Found', value: 'Database not configured', inline: true }
        )
        .setColor(0xFFA500)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (commandName === 'setmodlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'mod');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle('Configure Mod Action Logs')
        .setDescription('Select a channel where kick, ban, timeout, and unban actions will be logged.')
        .setColor(0xFF6B35);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'unban') {
      const rawId = interaction.options.getString('userid').trim();
      const reason = interaction.options.getString('reason') || 'No reason provided';

      if (!/^\d{17,20}$/.test(rawId)) {
        return interaction.reply({ content: 'That doesn\'t look like a valid user ID. IDs are 17–20 digit numbers.', ephemeral: true });
      }

      let target;
      try {
        target = await client.users.fetch(rawId);
      } catch {
        return interaction.reply({ content: `Could not find a user with ID \`${rawId}\`.`, ephemeral: true });
      }

      const banEntry = await interaction.guild.bans.fetch(rawId).catch(() => null);
      if (!banEntry) {
        return interaction.reply({ content: `${target.tag} is not currently banned from this server.`, ephemeral: true });
      }

      await interaction.guild.bans.remove(rawId, reason);
      const unbanEmbed = new EmbedBuilder()
        .setTitle('Member Unbanned')
        .setColor(0x00C853)
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .setTimestamp();
      await sendModLog(interaction.guild, unbanEmbed);
      return interaction.reply({ embeds: [unbanEmbed] });
    }

    if (commandName === 'setreactionlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'reaction');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Reaction Logs')
        .setDescription('Select a channel where reaction logs will be posted.')
        .setColor(0x5865F2);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false});
    }

    if (commandName === 'setdeletedlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'deleted');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Deleted Message Logs')
        .setDescription('Select a channel where deleted message logs will be posted.')
        .setColor(0xFF0000);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'seteditlogs') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const selectMenu = createChannelSelectMenu(interaction.guild.id, 'edit');
      const row = new ActionRowBuilder().addComponents(selectMenu);

      const embed = new EmbedBuilder()
        .setTitle(' Configure Message Edit Logs')
        .setDescription('Select a channel where message edit logs will be posted.')
        .setColor(0xFFA500);

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (commandName === 'logstatus') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to view logging status.', ephemeral: false });
      }

      const config = getServerConfig(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle(' Logging Configuration Status')
        .addFields(
          { 
            name: ' Reaction Logs', 
            value: config.reactionLogsChannel ? `<#${config.reactionLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: ' Deleted Message Logs', 
            value: config.deletedLogsChannel ? `<#${config.deletedLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          { 
            name: ' Edit Message Logs', 
            value: config.editLogsChannel ? `<#${config.editLogsChannel}>` : 'Not configured', 
            inline: true 
          },
          {
            name: 'Mod Action Logs',
            value: config.modLogsChannel ? `<#${config.modLogsChannel}>` : 'Not configured',
            inline: true
          }
        )
        .setColor(0x5865F2)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (commandName === 'say') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: false });
      }

      const targetChannel = interaction.options.getChannel('channel');
      const messageText = interaction.options.getString('message');

      // Verify the channel is a text channel in the same guild
      if (!targetChannel || targetChannel.type !== ChannelType.GuildText || targetChannel.guild.id !== interaction.guild.id) {
        return interaction.reply({ content: 'Invalid channel selected. Please choose a text channel from this server.', ephemeral: false });
      }

      try {
        // Send the message to the target channel
        await targetChannel.send(messageText);

        return interaction.reply({ 
          content: ` Message sent to ${targetChannel}`, 
          ephemeral: false 
        });
      } catch (error) {
        console.error('Error sending message:', error);
        return interaction.reply({ 
          content: 'Failed to send message. Check bot permissions for that channel.', 
          ephemeral: false 
        });
      }
    }

    if (commandName === 'riskreport') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      try {
        const report = await generateServerRiskReport(interaction.guild, interaction.user);
        const embed = await createRiskReportEmbed(report, interaction.guild);

        return interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Error generating risk report:', error);
        return interaction.editReply({ content: 'Error generating server risk report. Please try again.' });
      }
    }

    if (commandName === 'behavioursummary') {
      if (!isModerator(interaction.member)) {
        return interaction.reply({ content: 'You need moderator permissions to use this command.', ephemeral: false });
      }

      await interaction.deferReply();

      const target = interaction.options.getUser('user');

      try {
        const activityData = await getActivityData(interaction.guild.id, target.id, 14);
        const { embed, components } = buildActivityEmbed(target, 14, activityData);
        return interaction.editReply({ embeds: [embed], components });
      } catch (error) {
        console.error('Error generating behaviour summary:', error);
        return interaction.editReply({ content: 'Error generating behaviour summary. Please try again.' });
      }
    }

    if (commandName === 'quarantine') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to quarantine users.', ephemeral: false });
      }

      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: 'That user is not in this server.', ephemeral: false });
      }

      if (isAdmin(member)) {
        return interaction.reply({ content: 'You cannot quarantine an administrator.', ephemeral: false });
      }

      const quarantineRole = interaction.guild.roles.cache.find(r => r.name === 'Quarantined');
      if (quarantineRole && member.roles.cache.has(quarantineRole.id)) {
        return interaction.reply({ content: `**${target.tag}** is already quarantined.`, ephemeral: false });
      }

      await interaction.deferReply();
      const result = await quarantineUser(member, `Manually quarantined by ${interaction.user.tag}`, interaction.user);

      if (!result.success) {
        return interaction.editReply({
          content: `Failed to quarantine user: ${result.error}`
        });
      }

      const accountAgeDays = Math.floor((Date.now() - target.createdTimestamp) / (1000 * 60 * 60 * 24));
      const embed = new EmbedBuilder()
        .setTitle('User Quarantined')
        .setDescription(`**${target.tag}** has been quarantined and can no longer access any server channels.`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
          { name: 'Account Age', value: `${accountAgeDays} day${accountAgeDays !== 1 ? 's' : ''}`, inline: true },
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Reason', value: `Manually quarantined by ${interaction.user.tag}`, inline: false },
          { name: 'Quarantine Channel', value: `${result.quarantineChannel}`, inline: true },
          { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
        )
        .setColor(0xFF6B6B)
        .setFooter({ text: 'Use /allow to release this user from quarantine.' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === 'allow') {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to release users from quarantine.', ephemeral: false });
      }

      const target = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!member) {
        return interaction.reply({ content: 'That user is not in this server.', ephemeral: false });
      }

      const quarantineRole = interaction.guild.roles.cache.find(r => r.name === 'Quarantined');
      if (!quarantineRole || !member.roles.cache.has(quarantineRole.id)) {
        return interaction.reply({ content: 'That user is not currently quarantined.', ephemeral: false });
      }

      await interaction.deferReply();
      try {
        const botMember = interaction.guild.members.cache.get(client.user.id);
        const record = await QuarantinedUserModel.findOne({ guildId: interaction.guild.id, userId: member.id });

        // Remove the Quarantined role
        await member.roles.remove(quarantineRole, `Released from quarantine by ${interaction.user.tag}`);

        // Restore the user's saved roles from MongoDB
        if (record && record.savedRoles.length > 0) {
          const rolesToRestore = record.savedRoles.filter(id => {
            const role = interaction.guild.roles.cache.get(id);
            return role && role.id !== quarantineRole.id &&
                   botMember && botMember.roles.highest.comparePositionTo(role) > 0;
          });
          if (rolesToRestore.length > 0) {
            await member.roles.add(rolesToRestore, 'Quarantine released: restoring roles').catch(
              e => console.warn('Could not restore some roles:', e.message)
            );
          }
        }

        // Post release notice inside the private quarantine channel, then delete it
        const quarantineChannelId = record?.quarantineChannelId;
        const quarantineChannel = quarantineChannelId
          ? interaction.guild.channels.cache.get(quarantineChannelId)
          : null;

        if (quarantineChannel) {
          const releaseEmbed = new EmbedBuilder()
            .setTitle('User Released from Quarantine')
            .setDescription(`${member} has been cleared by **${interaction.user.tag}** and can now access the server normally. This channel will be deleted.`)
            .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
            .addFields(
              { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
              { name: 'Released By', value: `${interaction.user.tag}`, inline: true },
              { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
            )
            .setColor(0x57F287)
            .setTimestamp();
          await quarantineChannel.send({ embeds: [releaseEmbed] }).catch(() => {});
          // Wait briefly so the release message is visible before the channel is deleted
          await new Promise(r => setTimeout(r, 3000));
          await quarantineChannel.delete(`Quarantine released for ${target.tag}`).catch(
            e => console.warn('Could not delete quarantine channel:', e.message)
          );
        }

        // Clean up per-channel ViewChannel deny overrides for the Quarantined role on all channels
        for (const [, channel] of interaction.guild.channels.cache) {
          try {
            const overwrite = channel.permissionOverwrites.cache.get(quarantineRole.id);
            if (overwrite) await channel.permissionOverwrites.delete(quarantineRole.id);
          } catch (e) { /* ignore channels we can't edit */ }
        }

        // Delete the quarantine record
        await QuarantinedUserModel.deleteOne({ guildId: interaction.guild.id, userId: member.id })
          .catch(e => console.warn('Could not delete quarantine record:', e.message));

        // DM the released user
        try {
          const dmEmbed = new EmbedBuilder()
            .setTitle('Quarantine Lifted')
            .setDescription(`Your quarantine in **${interaction.guild.name}** has been lifted by a moderator. You can now access the server normally.`)
            .setColor(0x57F287)
            .setTimestamp();
          await member.send({ embeds: [dmEmbed] });
        } catch (e) { /* DMs may be closed */ }

        const successEmbed = new EmbedBuilder()
          .setTitle('User Released from Quarantine')
          .setDescription(`**${target.tag}** has been released from quarantine and can now access the server normally. Their private quarantine channel has been deleted.`)
          .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
          .addFields(
            { name: 'User', value: `${target.tag}\n\`${target.id}\``, inline: true },
            { name: 'Released By', value: `${interaction.user.tag}`, inline: true },
            { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
          )
          .setColor(0x57F287)
          .setTimestamp();

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (e) {
        console.error('Error releasing from quarantine:', e);
        return interaction.editReply({ content: `Failed to release user from quarantine: ${e.message}` });
      }
    }

    if (commandName === 'advanced') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'toggle') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need administrator permissions to configure advanced restrictions.', ephemeral: false });
        }

        const embed = new EmbedBuilder()
          .setTitle('Advanced Security Configuration')
          .setDescription('Select a text channel from the dropdown below to configure its content restrictions.\n\nYou can set a channel to **Messages Only** (text only, no images or videos) or **Media Only** (images and videos only, no text). You can also control which roles and users are subject to or exempt from these restrictions.')
          .addFields(
            { name: 'Messages Only', value: 'Allows text. Deletes any message containing images or video and returns the text to the sender.', inline: false },
            { name: 'Media Only', value: 'Allows images and video. Text-only messages are deleted, but messages that include both text and media are allowed.', inline: false }
          )
          .setColor(0x2B2D31)
          .setFooter({ text: 'Administrators are always exempt from restrictions.' })
          .setTimestamp();

        const channelSelect = new ChannelSelectMenuBuilder()
          .setCustomId(`adv_chan_${interaction.guild.id}`)
          .setPlaceholder('Select a channel to configure')
          .setChannelTypes([ChannelType.GuildText])
          .setMinValues(1)
          .setMaxValues(1);

        return interaction.reply({
          embeds: [embed],
          components: [new ActionRowBuilder().addComponents(channelSelect)]
        });
      }
    }

    if (commandName === 'setticket') {
      return await handleSetTicketCommand(interaction);
    }

    if (commandName === 'ticket') {
      return await handleTicketCommand(interaction);
    }

    if (commandName === 'configure') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'quarantine') {
        if (!isAdmin(interaction.member)) {
          return interaction.reply({ content: 'You need administrator permissions to configure quarantine.', ephemeral: false });
        }

        const config = getServerConfig(interaction.guild.id);
        const qConfig = config.quarantine;

        const embed = new EmbedBuilder()
          .setTitle(' Quarantine Configuration')
          .setDescription('Toggle settings using the buttons below. Changes take effect immediately.')
          .addFields(
            { name: 'Quarantine System', value: qConfig.enabled ? ' Enabled' : ' Disabled', inline: true },
            { name: 'Account Age Check', value: qConfig.ageEnabled ? ` Enabled (< ${qConfig.ageThreshold} days)` : ' Disabled', inline: true },
            { name: 'Mass Join Detection', value: qConfig.massJoinEnabled ? ` Enabled (${qConfig.massJoinCount} joins / ${qConfig.massJoinTime}min)` : ' Disabled', inline: true }
          )
          .setColor(0x5865F2)
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`qconfig_toggle_${interaction.guild.id}`)
            .setLabel(qConfig.enabled ? 'Disable Quarantine' : 'Enable Quarantine')
            .setStyle(qConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`qconfig_age_${interaction.guild.id}`)
            .setLabel(qConfig.ageEnabled ? 'Disable Age Check' : 'Enable Age Check')
            .setStyle(qConfig.ageEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`qconfig_massjoin_${interaction.guild.id}`)
            .setLabel(qConfig.massJoinEnabled ? 'Disable Mass Join' : 'Enable Mass Join')
            .setStyle(qConfig.massJoinEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
        );

        return interaction.reply({ embeds: [embed], components: [row] });
      }
    }
  }

  //  Select menu interaction handler
  if (interaction.isStringSelectMenu()) {
    const customIdParts = interaction.customId.split('_');
    const action = customIdParts[0];
    const logType = customIdParts[1];
    const guildId = customIdParts[3];

    if (action === 'select' && guildId === interaction.guild.id) {
      if (!isAdmin(interaction.member)) {
        return interaction.reply({ content: 'You need administrator permissions to configure logging.', ephemeral: false });
      }

      const channelId = interaction.values[0];
      if (channelId === 'none') {
        return interaction.reply({ content: 'No valid channels available. Create a text channel first.', ephemeral: false });
      }

      const config = getServerConfig(guildId);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (logType === 'reaction') {
        config.reactionLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Reaction logs configured for ${channel}`, embeds: [], components: [] });
      } else if (logType === 'deleted') {
        config.deletedLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Deleted message logs configured for ${channel}`, embeds: [], components: [] });
      } else if (logType === 'edit') {
        config.editLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Message edit logs configured for ${channel}`, embeds: [], components: [] });
      } else if (logType === 'mod') {
        config.modLogsChannel = channelId;
        serverConfigs.set(guildId, config);
        saveServerConfig(guildId).catch(console.error);
        return interaction.update({ content: `Mod action logs configured for ${channel}`, embeds: [], components: [] });
      }
    }
  }

  // Advanced config: channel select
  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('adv_chan_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.values[0];
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: restricted roles select
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('adv_roles_restrict_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.customId.replace('adv_roles_restrict_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.restrictedRoles = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: exempt roles select
  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('adv_roles_exempt_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.customId.replace('adv_roles_exempt_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.exemptRoles = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: exempt users select
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('adv_users_exempt_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.customId.replace('adv_users_exempt_', '');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.exemptUsers = interaction.values;
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Advanced config: warning timer modal submission
  if (interaction.isModalSubmit() && interaction.customId.startsWith('adv_timer_modal_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.customId.replace('adv_timer_modal_', '');
    const raw = interaction.fields.getTextInputValue('timer_value').trim();
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      return interaction.reply({ content: 'Please enter a valid number of seconds (0 for never).', ephemeral: false });
    }
    const serverCfg = getServerConfig(interaction.guild.id);
    serverCfg.warnDeleteTimeout = parsed === 0 ? null : parsed;
    serverConfigs.set(interaction.guild.id, serverCfg);
    saveServerConfig(interaction.guild.id).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  //  Button interaction handler
  if (!interaction.isButton()) return;

  // Advanced config: mode buttons
  if (interaction.customId.startsWith('adv_mode_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const parts = interaction.customId.split('_');
    const mode = parts[2];
    const channelId = parts.slice(3).join('_');
    const cfg = getAdvancedChannelConfig(interaction.guild.id, channelId);
    cfg.mode = mode === 'off' ? null : mode === 'messages' ? 'messages_only' : 'media_only';
    saveAdvancedChannelConfig(interaction.guild.id, channelId).catch(console.error);
    const panel = buildAdvancedPanel(interaction.guild, channelId);
    return interaction.update(panel);
  }

  // Behaviour summary period navigation buttons
  if (interaction.customId.startsWith('bsum_')) {
    const parts = interaction.customId.split('_');
    const days = parseInt(parts[1]);
    const userId = parts[2];
    try {
      const user = await interaction.client.users.fetch(userId);
      const activityData = await getActivityData(interaction.guild.id, userId, days);
      const { embed, components } = buildActivityEmbed(user, days, activityData);
      return interaction.update({ embeds: [embed], components });
    } catch (error) {
      console.error('Error updating behaviour summary:', error);
      return interaction.reply({ content: 'Failed to load activity data.', ephemeral: false });
    }
  }

  // Advanced config: warning timer button — opens a modal
  if (interaction.customId.startsWith('adv_timer_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }
    const channelId = interaction.customId.replace('adv_timer_', '');
    const serverCfg = getServerConfig(interaction.guild.id);
    const current = serverCfg.warnDeleteTimeout === null ? '0' : String(serverCfg.warnDeleteTimeout);
    const modal = new ModalBuilder()
      .setCustomId(`adv_timer_modal_${channelId}`)
      .setTitle('Set Warning Message Timer');
    const input = new TextInputBuilder()
      .setCustomId('timer_value')
      .setLabel('Delete after how many seconds? (0 = never delete)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 30, 60, 300 — enter 0 for infinite')
      .setValue(current)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // Handle quarantine config toggle buttons
  if (interaction.customId.startsWith('qconfig_')) {
    if (!isAdmin(interaction.member)) {
      return interaction.reply({ content: 'You need administrator permissions.', ephemeral: false });
    }

    const parts = interaction.customId.split('_');
    const setting = parts[1];
    const guildId = parts.slice(2).join('_');

    const config = getServerConfig(guildId);
    const qConfig = config.quarantine;

    if (setting === 'toggle') {
      qConfig.enabled = !qConfig.enabled;
    } else if (setting === 'age') {
      qConfig.ageEnabled = !qConfig.ageEnabled;
      if (qConfig.ageEnabled && qConfig.ageThreshold === 0) qConfig.ageThreshold = 7;
    } else if (setting === 'massjoin') {
      qConfig.massJoinEnabled = !qConfig.massJoinEnabled;
    }

    serverConfigs.set(guildId, config);
    saveServerConfig(guildId).catch(console.error);

    const embed = new EmbedBuilder()
      .setTitle(' Quarantine Configuration')
      .setDescription('Toggle settings using the buttons below. Changes take effect immediately.')
      .addFields(
        { name: 'Quarantine System', value: qConfig.enabled ? ' Enabled' : ' Disabled', inline: true },
        { name: 'Account Age Check', value: qConfig.ageEnabled ? ` Enabled (< ${qConfig.ageThreshold} days)` : ' Disabled', inline: true },
        { name: 'Mass Join Detection', value: qConfig.massJoinEnabled ? ` Enabled (${qConfig.massJoinCount} joins / ${qConfig.massJoinTime}min)` : ' Disabled', inline: true }
      )
      .setColor(0x5865F2)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`qconfig_toggle_${guildId}`)
        .setLabel(qConfig.enabled ? 'Disable Quarantine' : 'Enable Quarantine')
        .setStyle(qConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`qconfig_age_${guildId}`)
        .setLabel(qConfig.ageEnabled ? 'Disable Age Check' : 'Enable Age Check')
        .setStyle(qConfig.ageEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`qconfig_massjoin_${guildId}`)
        .setLabel(qConfig.massJoinEnabled ? 'Disable Mass Join' : 'Enable Mass Join')
        .setStyle(qConfig.massJoinEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
    );

    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (interaction.customId.startsWith('check_from_search_')) {
    if (!isModerator(interaction.member)) {
      return interaction.reply({ content: 'You need moderator permissions to run a risk check.', ephemeral: true });
    }
    const targetId = interaction.customId.replace('check_from_search_', '');
    await interaction.deferReply();
    const target = await client.users.fetch(targetId, { force: true }).catch(() => null);
    if (!target) return interaction.editReply({ content: 'Could not fetch this user.' });
    const risk = await calculateRisk(target, interaction.guild);
    const mutualAnalysis = await analyzeMutualConnections(target, interaction.user, client);
    risk.mutualAnalysis = mutualAnalysis;
    if (mutualAnalysis.hasCloseTimingPattern) { risk.score += 25; risk.factors.push('Suspicious mutual server timing patterns'); }
    if (mutualAnalysis.mutualCount === 0) { risk.score += 5; risk.factors.push('No detectable mutual servers'); }
    risk.score = Math.max(0, Math.min(100, risk.score));
    if (risk.score >= 80) risk.label = 'Critical';
    else if (risk.score >= 60) risk.label = 'High';
    else if (risk.score >= 35) risk.label = 'Medium';
    else if (risk.score >= 15) risk.label = 'Low';
    else risk.label = 'Minimal';
    const embed = await makeCheckEmbed(target, risk, interaction.guild);
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    const isTargetAdmin = targetMember && isAdmin(targetMember);
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`allow_${targetId}`).setLabel('Allow').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`kick_${targetId}`).setLabel(isTargetAdmin ? 'Kick (Admin Immune)' : 'Kick').setStyle(ButtonStyle.Danger).setDisabled(isTargetAdmin),
      new ButtonBuilder().setCustomId(`ban_${targetId}`).setLabel(isTargetAdmin ? 'Ban (Admin Immune)' : 'Ban').setStyle(ButtonStyle.Danger).setDisabled(isTargetAdmin)
    );
    return interaction.editReply({ embeds: [embed], components: [buttons] });
  }

  const [action, userId] = interaction.customId.split('_');
  const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
  const member = await interaction.guild.members.fetch(userId).catch(() => null);

  if (!targetUser) {
    return interaction.reply({ content: 'User not found.', ephemeral: false });
  }

  // Check if target is admin (immune to moderation)
  const isTargetAdmin = member && isAdmin(member);

  if (action === 'allow') {
    return interaction.update({ content: ` Allowed **${targetUser.tag}**`, components: [], embeds: interaction.message.embeds });
  }

  if (action === 'kick') {
    if (!interaction.member.permissions.has('KickMembers')) {
      return interaction.reply({ content: 'You do not have permission to kick.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: 'User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: 'Cannot kick this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: ` Are you sure you want to **kick** ${targetUser.tag}?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirmkick_${userId}`).setLabel('Yes, Kick').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: false
    });
  }

  if (action === 'ban') {
    if (!interaction.member.permissions.has('BanMembers')) {
      return interaction.reply({ content: 'You do not have permission to ban.', ephemeral: false });
    }
    if (!member) return interaction.reply({ content: 'User is not in the server.', ephemeral: false });

    if (isTargetAdmin) {
      return interaction.reply({ content: 'Cannot ban this user - they have administrator privileges.', ephemeral: false });
    }

    return interaction.reply({
      content: ` Are you sure you want to **ban** ${targetUser.tag}?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirmban_${userId}`).setLabel('Yes, Ban').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: false
    });
  }

  if (action === 'confirmkick') {
    if (isTargetAdmin) {
      return interaction.update({ content: 'Cannot kick this user - they have administrator privileges.', components: [] });
    }
    await member.kick(`Kicked by ${interaction.user.tag} via alt check`).catch(() => null);
    return interaction.update({ content: ` Kicked **${targetUser.tag}**`, components: [] });
  }

  if (action === 'confirmban') {
    if (isTargetAdmin) {
      return interaction.update({ content: 'Cannot ban this user - they have administrator privileges.', components: [] });
    }
    await member.ban({ reason: `Banned by ${interaction.user.tag} via alt check` }).catch(() => null);
    return interaction.update({ content: ` Banned **${targetUser.tag}**`, components: [] });
  }

  if (action === 'cancel') {
    return interaction.update({ content: 'Action cancelled.', components: [] });
  }

  } catch (error) {
    console.error('Error handling interaction:', error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: false });
      } catch (e) {
        console.error('Failed to send error reply:', e);
      }
    } else {
      try {
        await interaction.followUp({ content: 'An error occurred while processing your request.', ephemeral: false });
      } catch (e) {
        console.error('Failed to send error followup:', e);
      }
    }
  }
});

//  Message deleted event handler
client.on('messageDelete', async message => {
  // Ignore bot messages and system messages
  if (!message.author || message.author.bot || message.system) return;

  // Populate =dsnipe cache
  if (message.guild) {
    snipeDeleteCache.set(message.channel.id, {
      author: message.author,
      content: message.content || '',
      attachments: [...message.attachments.values()],
      deletedAt: Date.now()
    });
  }

  // Watchlist: auto-log deleted messages for watched users
  if (message.guild && message.author && await isWatched(message.guild.id, message.author.id)) {
    const content = message.content || '';
    const attachments = [...message.attachments.values()];
    let text = `<@${message.author.id}>: ${content || '*[no text content]*'}`;
    if (attachments.length > 0) {
      text += '\n' + attachments.map(a => `[${a.name}](${a.url})`).join('\n');
    }
    message.channel.send(text).catch(console.error);
  }

  const config = getServerConfig(message.guild.id);
  if (!config.deletedLogsChannel) return;

  const logChannel = message.guild.channels.cache.get(config.deletedLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('Message Deleted')
    .setColor(0xFF0000)
    .addFields(
      { name: 'Author', value: `${message.author.tag} (${message.author.id})`, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Deleted At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (message.content) {
    embed.addFields({ 
      name: ' Content', 
      value: message.content.length > 1024 ? `${message.content.substring(0, 1021)}...` : message.content,
      inline: false 
    });
  }

  if (message.attachments.size > 0) {
    const attachmentList = message.attachments.map(att => `[${att.name}](${att.url})`).join('\n');
    embed.addFields({ 
      name: ' Attachments', 
      value: attachmentList.length > 1024 ? `${attachmentList.substring(0, 1021)}...` : attachmentList,
      inline: false 
    });
  }

  embed.setFooter({ text: `Message ID: ${message.id}` });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending deleted message log:', error);
  }
});

//  Message edited event handler
client.on('messageUpdate', async (oldMessage, newMessage) => {
  // Ignore bot messages, system messages, and messages without content changes
  if (!newMessage.author || newMessage.author.bot || newMessage.system) return;
  if (oldMessage.content === newMessage.content) return; // No content change

  // Populate =esnipe cache
  if (newMessage.guild) {
    snipeEditCache.set(newMessage.channel.id, {
      author: newMessage.author,
      before: oldMessage.content || '',
      after: newMessage.content || '',
      messageUrl: newMessage.url,
      editedAt: Date.now()
    });
  }

  // Watchlist: auto-log edits for watched users (private watch log channel)
  if (newMessage.guild && newMessage.author && await isWatched(newMessage.guild.id, newMessage.author.id)) {
    const watchCfg = getServerConfig(newMessage.guild.id);
    if (watchCfg.watchLogChannel) {
      const watchLog = newMessage.guild.channels.cache.get(watchCfg.watchLogChannel);
      if (watchLog) {
        const watchEmbed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setAuthor({ name: `${newMessage.author.tag}`, iconURL: newMessage.author.displayAvatarURL({ dynamic: true }) })
          .addFields(
            { name: 'Before', value: (oldMessage.content || '*[empty]*').slice(0, 512), inline: false },
            { name: 'After', value: (newMessage.content || '*[empty]*').slice(0, 512), inline: false },
            { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
            { name: 'Jump to Message', value: `[Click here](${newMessage.url})`, inline: true }
          )
          .setFooter({ text: `Watchlist  •  Edited Message  •  ${newMessage.author.id}` })
          .setTimestamp();
        watchLog.send({ embeds: [watchEmbed] }).catch(console.error);
      }
    }
  }

  const config = getServerConfig(newMessage.guild.id);
  if (!config.editLogsChannel) return;

  const logChannel = newMessage.guild.channels.cache.get(config.editLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(' Message Edited')
    .setColor(0xFFA500)
    .addFields(
      { name: ' Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Edited At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setTimestamp();

  if (oldMessage.content) {
    embed.addFields({ 
      name: ' Before', 
      value: oldMessage.content.length > 512 ? `${oldMessage.content.substring(0, 509)}...` : oldMessage.content,
      inline: false 
    });
  }

  if (newMessage.content) {
    embed.addFields({ 
      name: ' After', 
      value: newMessage.content.length > 512 ? `${newMessage.content.substring(0, 509)}...` : newMessage.content,
      inline: false 
    });
  }

  embed.addFields({ 
    name: ' Jump to Message', 
    value: `[Click here](${newMessage.url})`,
    inline: true 
  });

  embed.setFooter({ text: `Message ID: ${newMessage.id}` });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending edited message log:', error);
  }
});

//  Reaction added event handler
client.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial reactions
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Error fetching reaction:', error);
      return;
    }
  }

  // Watchlist: auto-log reactions added by watched users (private watch log channel)
  if (reaction.message.guild && await isWatched(reaction.message.guild.id, user.id)) {
    const watchCfg = getServerConfig(reaction.message.guild.id);
    if (watchCfg.watchLogChannel) {
      const watchLog = reaction.message.guild.channels.cache.get(watchCfg.watchLogChannel);
      if (watchLog) {
        const watchEmbed = new EmbedBuilder()
          .setColor(0x57F287)
          .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL({ dynamic: true }) })
          .setDescription(`<@${user.id}> added reaction **${reaction.emoji}** to [this message](${reaction.message.url})`)
          .addFields(
            { name: 'Channel', value: `<#${reaction.message.channel.id}>`, inline: true },
            { name: 'Message Content', value: (reaction.message.content || '*[no content]*').slice(0, 256), inline: false }
          )
          .setFooter({ text: `Watchlist  •  Reaction Added  •  ${user.id}` })
          .setTimestamp();
        watchLog.send({ embeds: [watchEmbed] }).catch(console.error);
      }
    }
  }

  const config = getServerConfig(reaction.message.guild.id);
  if (!config.reactionLogsChannel) return;

  const logChannel = reaction.message.guild.channels.cache.get(config.reactionLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(' Reaction Added')
    .setColor(0x00FF00)
    .addFields(
      { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
      { name: 'Channel', value: `${reaction.message.channel}`, inline: true },
      { name: 'Added At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: 'Reaction', value: `${reaction.emoji}`, inline: true },
      { name: 'Count', value: `${reaction.count}`, inline: true },
      { name: 'Message', value: `[Jump to message](${reaction.message.url})`, inline: true }
    )
    .setTimestamp();

  if (reaction.message.content) {
    const content = reaction.message.content.length > 200 ? 
      `${reaction.message.content.substring(0, 197)}...` : 
      reaction.message.content;
    embed.addFields({ name: ' Message Content', value: content, inline: false });
  }

  embed.setFooter({ 
    text: `Message ID: ${reaction.message.id} | Author: ${reaction.message.author?.tag || 'Unknown'}` 
  });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending reaction log:', error);
  }
});

//  Reaction removed event handler
client.on('messageReactionRemove', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial reactions
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Error fetching reaction:', error);
      return;
    }
  }

  // Populate =rsnipe cache
  if (reaction.message.guild) {
    snipeReactionCache.set(reaction.message.channel.id, {
      user,
      emoji: reaction.emoji.toString(),
      messageContent: reaction.message.content || '',
      messageUrl: reaction.message.url,
      messageAuthorTag: reaction.message.author?.tag || 'Unknown',
      removedAt: Date.now()
    });
  }

  // Watchlist: auto-log reactions removed by watched users (private watch log channel)
  if (reaction.message.guild && await isWatched(reaction.message.guild.id, user.id)) {
    const watchCfg = getServerConfig(reaction.message.guild.id);
    if (watchCfg.watchLogChannel) {
      const watchLog = reaction.message.guild.channels.cache.get(watchCfg.watchLogChannel);
      if (watchLog) {
        const watchEmbed = new EmbedBuilder()
          .setColor(0xFF4444)
          .setAuthor({ name: `${user.tag}`, iconURL: user.displayAvatarURL({ dynamic: true }) })
          .setDescription(`<@${user.id}> removed reaction **${reaction.emoji}** from [this message](${reaction.message.url})`)
          .addFields(
            { name: 'Channel', value: `<#${reaction.message.channel.id}>`, inline: true },
            { name: 'Message Content', value: (reaction.message.content || '*[no content]*').slice(0, 256), inline: false }
          )
          .setFooter({ text: `Watchlist  •  Reaction Removed  •  ${user.id}` })
          .setTimestamp();
        watchLog.send({ embeds: [watchEmbed] }).catch(console.error);
      }
    }
  }

  const config = getServerConfig(reaction.message.guild.id);
  if (!config.reactionLogsChannel) return;

  const logChannel = reaction.message.guild.channels.cache.get(config.reactionLogsChannel);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('Reaction Removed')
    .setColor(0xFF4444)
    .addFields(
      { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
      { name: 'Channel', value: `${reaction.message.channel}`, inline: true },
      { name: 'Removed At', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: 'Reaction', value: `${reaction.emoji}`, inline: true },
      { name: 'Count', value: `${reaction.count}`, inline: true },
      { name: 'Message', value: `[Jump to message](${reaction.message.url})`, inline: true }
    )
    .setTimestamp();

  if (reaction.message.content) {
    const content = reaction.message.content.length > 200 ? 
      `${reaction.message.content.substring(0, 197)}...` : 
      reaction.message.content;
    embed.addFields({ name: ' Message Content', value: content, inline: false });
  }

  embed.setFooter({ 
    text: `Message ID: ${reaction.message.id} | Author: ${reaction.message.author?.tag || 'Unknown'}` 
  });

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending reaction removal log:', error);
  }
});

//  Auto-quarantine on member join
client.on('guildMemberAdd', async member => {
  const config = getServerConfig(member.guild.id);
  if (!config.quarantine.enabled) return;

  const user = member.user;
  const guildId = member.guild.id;
  const qConfig = config.quarantine;

  // Track join times for mass join detection
  if (!joinLog.has(guildId)) joinLog.set(guildId, []);
  const guildJoins = joinLog.get(guildId);
  guildJoins.push(Date.now());

  // Clean up joins outside the detection window
  const windowMs = qConfig.massJoinTime * 60 * 1000;
  const recentJoins = guildJoins.filter(t => Date.now() - t < windowMs);
  joinLog.set(guildId, recentJoins);

  let shouldQuarantine = false;
  let reason = '';

  // Account age check
  if (qConfig.ageEnabled && qConfig.ageThreshold > 0) {
    const accountAgeDays = (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (accountAgeDays < qConfig.ageThreshold) {
      shouldQuarantine = true;
      reason = `New account: ${Math.floor(accountAgeDays)} days old (threshold: ${qConfig.ageThreshold} days)`;
    }
  }

  // Mass join check
  if (qConfig.massJoinEnabled && recentJoins.length >= qConfig.massJoinCount) {
    shouldQuarantine = true;
    reason = `Mass join detected: ${recentJoins.length} users joined in the last ${qConfig.massJoinTime} minutes`;
  }

  if (shouldQuarantine) {
    const result = await quarantineUser(member, reason);
    if (result && !result.success) {
      console.error(`Auto-quarantine failed for ${member.user.tag}: ${result.error}`);
    }
  }
});

//  Server Risk Assessment Functions
async function generateServerRiskReport(guild, requestingUser) {
  const report = {
    serverInfo: {
      name: guild.name,
      memberCount: guild.memberCount,
      createdAt: guild.createdTimestamp,
      verificationLevel: guild.verificationLevel,
      hasIcon: !!guild.icon,
      hasBanner: !!guild.banner
    },
    suspiciousUsers: [],
    massJoinEvents: [],
    securityMetrics: {
      totalMembers: 0,
      newAccounts: 0,
      highRiskUsers: 0,
      mediumRiskUsers: 0,
      lowRiskUsers: 0,
      averageRiskScore: 0,
      inviteSpammers: 0,
      everyoneMentioners: 0,
      advertisementPosters: 0
    },
    serverSafetyScore: 0,
    moderationLevel: 'Unknown',
    recommendations: []
  };

  try {
    // Fetch all members (limited by Discord API)
    const members = await guild.members.fetch({ limit: 1000 });
    report.securityMetrics.totalMembers = members.size;

    const memberRisks = [];
    const joinTimes = [];
    const suspiciousPatterns = new Map();

    // Analyze each member
    for (const [memberId, member] of members) {
      if (member.user.bot) continue;

      const risk = await calculateRisk(member.user, guild);
      memberRisks.push(risk.score);
      joinTimes.push(member.joinedTimestamp);

      // Categorize risk levels
      if (risk.score >= 60) {
        report.securityMetrics.highRiskUsers++;
        report.suspiciousUsers.push({
          user: member.user,
          riskScore: risk.score,
          riskLevel: risk.label,
          factors: risk.factors.slice(0, 3),
          joinedAt: member.joinedTimestamp
        });
      } else if (risk.score >= 35) {
        report.securityMetrics.mediumRiskUsers++;
      } else {
        report.securityMetrics.lowRiskUsers++;
      }

      // Check for new accounts
      const accountAge = Date.now() - member.user.createdTimestamp;
      if (accountAge < 7 * 24 * 60 * 60 * 1000) { // 7 days
        report.securityMetrics.newAccounts++;
      }

      // Detect mass join patterns
      const joinHour = new Date(member.joinedTimestamp).getHours();
      const joinKey = `${new Date(member.joinedTimestamp).toDateString()}_${joinHour}`;
      if (!suspiciousPatterns.has(joinKey)) {
        suspiciousPatterns.set(joinKey, []);
      }
      suspiciousPatterns.get(joinKey).push({
        user: member.user,
        joinTime: member.joinedTimestamp
      });
    }

    // Detect mass join events
    for (const [timeKey, users] of suspiciousPatterns) {
      if (users.length >= 5) { // 5+ users joined in same hour
        report.massJoinEvents.push({
          timeframe: timeKey,
          userCount: users.length,
          users: users.slice(0, 5) // Show first 5
        });
      }
    }

    // Calculate average risk score
    if (memberRisks.length > 0) {
      report.securityMetrics.averageRiskScore = Math.round(
        memberRisks.reduce((sum, score) => sum + score, 0) / memberRisks.length
      );
    }

    // Analyze server configuration
    const serverConfigScore = analyzeServerConfiguration(guild);

    // Calculate overall server safety score
    const riskPenalty = (report.securityMetrics.highRiskUsers * 15) + 
                       (report.securityMetrics.mediumRiskUsers * 5) +
                       (report.massJoinEvents.length * 10);

    const baseScore = Math.max(0, 100 - riskPenalty);
    report.serverSafetyScore = Math.min(100, Math.max(0, baseScore + serverConfigScore));

    // Determine moderation level
    if (report.serverSafetyScore >= 85) {
      report.moderationLevel = 'Excellent';
    } else if (report.serverSafetyScore >= 70) {
      report.moderationLevel = 'Good';
    } else if (report.serverSafetyScore >= 50) {
      report.moderationLevel = 'Moderate';
    } else if (report.serverSafetyScore >= 30) {
      report.moderationLevel = 'Poor';
    } else {
      report.moderationLevel = 'Critical';
    }

    // Generate recommendations
    generateRecommendations(report);

    // Sort suspicious users by risk score
    report.suspiciousUsers.sort((a, b) => b.riskScore - a.riskScore);
    report.suspiciousUsers = report.suspiciousUsers.slice(0, 10); // Limit to top 10

  } catch (error) {
    console.error('Error generating server risk report:', error);
    throw error;
  }

  return report;
}

function analyzeServerConfiguration(guild) {
  let score = 0;

  // Verification level bonus
  if (guild.verificationLevel >= 3) score += 15;
  else if (guild.verificationLevel >= 2) score += 10;
  else if (guild.verificationLevel >= 1) score += 5;

  // Server age bonus
  const serverAge = Date.now() - guild.createdTimestamp;
  const ageDays = Math.floor(serverAge / (1000 * 60 * 60 * 24));
  if (ageDays > 365) score += 10;
  else if (ageDays > 90) score += 5;

  // Server branding bonus
  if (guild.icon) score += 3;
  if (guild.banner) score += 2;

  // Role structure analysis
  const roleCount = guild.roles.cache.size;
  if (roleCount > 10) score += 5;
  else if (roleCount > 5) score += 3;

  return Math.min(20, score); // Cap at 20 points
}

function generateRecommendations(report) {
  const recommendations = [];

  if (report.securityMetrics.highRiskUsers > 5) {
    recommendations.push('Not looking good for your server. There is a lot of risky users out there. Consider reviewing the member verification process.');
  }

  if (report.massJoinEvents.length > 2) {
    recommendations.push('There has been a lot of mass-join events recently. Are you sure your server is safe? Enable member verification or screening.');
  }

  if (report.securityMetrics.newAccounts > report.securityMetrics.totalMembers * 0.3) {
    recommendations.push('Yeesh, I detect a lot of new accounts joining this server. Consider implementing the minimum account age requirements.');
  }

  if (report.serverSafetyScore < 50) {
    recommendations.push('Low server safety score. Review moderation settings and consider additional security measures.');
  }

  if (report.serverInfo.verificationLevel < 2) {
    recommendations.push('Consider increasing server verification level for better security.');
  }

  if (recommendations.length === 0) {
    recommendations.push(' You have pretty great security going on in your server. keep it up :>');
  }

  report.recommendations = recommendations.slice(0, 5); // Limit to 5 recommendations
}

async function createRiskReportEmbed(report, guild) {
  const colors = {
    'Excellent': 0x00FF00,
    'Good': 0x90EE90,
    'Moderate': 0xFFFF00,
    'Poor': 0xFF6600,
    'Critical': 0xFF0000
  };

  const embed = new EmbedBuilder()
    .setTitle('Server Security & Safety Report')
    .setDescription(`**${guild.name}** Security Assessment`)
    .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
    .setColor(colors[report.moderationLevel] || 0x5865F2)
    .setTimestamp();

  // Overall metrics
  embed.addFields(
    { name: 'Safety Score', value: `**${report.serverSafetyScore}/100**`, inline: true },
    { name: 'Moderation Level', value: report.moderationLevel, inline: true },
    { name: 'Average Risk', value: `${report.securityMetrics.averageRiskScore}/100`, inline: true }
  );

  // Member analysis
  embed.addFields(
    { name: 'Total Members', value: report.securityMetrics.totalMembers.toString(), inline: true },
    { name: 'High Risk', value: report.securityMetrics.highRiskUsers.toString(), inline: true },
    { name: 'Medium Risk', value: report.securityMetrics.mediumRiskUsers.toString(), inline: true }
  );

  // Security indicators
  embed.addFields(
    { name: 'New Accounts (< 7d)', value: report.securityMetrics.newAccounts.toString(), inline: true },
    { name: 'Mass Join Events', value: report.massJoinEvents.length.toString(), inline: true },
    { name: 'Verification Level', value: report.serverInfo.verificationLevel.toString(), inline: true }
  );

  // Suspicious users (if any)
  if (report.suspiciousUsers.length > 0) {
    const suspiciousText = report.suspiciousUsers.slice(0, 5).map(user => 
      `**${user.user.tag}** (${user.riskScore}/100) - ${user.riskLevel}`
    ).join('\n');

    embed.addFields({
      name: 'Suspicious Users:',
      value: suspiciousText,
      inline: false
    });
  }

  // Mass join events (if any)
  if (report.massJoinEvents.length > 0) {
    const massJoinText = report.massJoinEvents.slice(0, 3).map(event => 
      `**${event.userCount} users** joined during ${event.timeframe.split('_')[0]}`
    ).join('\n');

    embed.addFields({
      name: 'Recent Mass Join Events',
      value: massJoinText,
      inline: false
    });
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    embed.addFields({
      name: 'Security Recommendations',
      value: report.recommendations.join('\n'),
      inline: false
    });
  }

  embed.setFooter({ 
    text: `Report generated • ${report.securityMetrics.highRiskUsers + report.securityMetrics.mediumRiskUsers} potentially risky users identified`,
    iconURL: guild.iconURL({ dynamic: true })
  });

  return embed;
}

// Activity Analysis Functions

async function getActivityData(guildId, userId, days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  const records = await ActivityLogModel.find({
    guildId, userId, date: { $in: dates }
  }).lean();
  const recordMap = new Map(records.map(r => [r.date, r]));
  return dates.map(date => ({
    date,
    messages:       recordMap.get(date)?.messages ?? 0,
    links:          recordMap.get(date)?.links ?? 0,
    mentions:       recordMap.get(date)?.mentions ?? 0,
    uniqueChannels: recordMap.get(date)?.uniqueChannels?.length ?? 0
  }));
}

function buildDetailedGraph(activityData) {
  const maxMsgs = Math.max(...activityData.map(d => d.messages), 1);
  const graphHeight = 6;
  const dayAbbr = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const lines = [];
  for (let row = graphHeight; row >= 1; row--) {
    const threshold = (row / graphHeight) * maxMsgs;
    const label = Math.round(threshold).toString().padStart(4);
    const bar = activityData.map(d => (d.messages >= threshold && d.messages > 0) ? '█ ' : '  ').join('');
    lines.push(label + '│' + bar);
  }
  lines.push('    └' + '──'.repeat(activityData.length));
  const dayRow = '    ' + activityData.map(d => {
    const dow = new Date(d.date + 'T12:00:00Z').getDay();
    return dayAbbr[dow];
  }).join('');
  lines.push(dayRow);
  return lines.join('\n');
}

function buildDailyTable(activityData) {
  const maxMsgs = Math.max(...activityData.map(d => d.messages), 1);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const header = 'Day  Date  │ Msg │ Ch │ Lk │ Mt │ Activity';
  const sep    = '─'.repeat(45);
  const rows = activityData.map(d => {
    const dt = new Date(d.date + 'T12:00:00Z');
    const dayName = dayNames[dt.getDay()];
    const month   = String(dt.getMonth() + 1).padStart(2, '0');
    const dayNum  = String(dt.getDate()).padStart(2, '0');
    const msgs = d.messages.toString().padStart(3);
    const chs  = d.uniqueChannels.toString().padStart(2);
    const lks  = d.links.toString().padStart(2);
    const mts  = d.mentions.toString().padStart(2);
    const barLen = d.messages === 0 ? 0 : Math.max(1, Math.round((d.messages / maxMsgs) * 8));
    const bar  = '█'.repeat(barLen);
    return dayName + ' ' + month + '/' + dayNum + ' │ ' + msgs + ' │ ' + chs + ' │ ' + lks + ' │ ' + mts + ' │ ' + bar;
  });
  return [header, sep, ...rows].join('\n');
}

function buildActivityEmbed(user, days, activityData) {
  const totalMessages = activityData.reduce((s, d) => s + d.messages, 0);
  const totalLinks    = activityData.reduce((s, d) => s + d.links, 0);
  const totalMentions = activityData.reduce((s, d) => s + d.mentions, 0);
  const activeDays    = activityData.filter(d => d.messages > 0).length;
  const avgPerDay     = days > 0 ? Math.round(totalMessages / days) : 0;
  const peakDay       = activityData.reduce((best, d) => d.messages > best.messages ? d : best, activityData[0]);
  const consistencyScore = Math.round((activeDays / days) * 100);

  const half       = Math.floor(activityData.length / 2);
  const firstHalf  = activityData.slice(0, half).reduce((s, d) => s + d.messages, 0);
  const secondHalf = activityData.slice(half).reduce((s, d) => s + d.messages, 0);
  let trend = 'Stable —';
  if (totalMessages > 0) {
    if (secondHalf > firstHalf * 1.25)      trend = 'Increasing ↑';
    else if (secondHalf < firstHalf * 0.75) trend = 'Decreasing ↓';
  }

  const periodLabel = days === 14 ? '2 Weeks' : days + ' Days';
  const peakStr     = totalMessages > 0 ? peakDay.date + ' (' + peakDay.messages + ' msgs)' : 'No activity';

  const fields = [
    { name: 'Total Messages', value: totalMessages.toString(), inline: true },
    { name: 'Avg / Day',      value: avgPerDay.toString(),     inline: true },
    { name: 'Active Days',    value: activeDays + ' / ' + days, inline: true },
    { name: 'Peak Day',       value: peakStr,    inline: true },
    { name: 'Trend',          value: trend,      inline: true },
    { name: 'Consistency',    value: consistencyScore + '%',  inline: true }
  ];

  if (totalMessages > 0) {
    const graph = buildDetailedGraph(activityData);
    const table = buildDailyTable(activityData);
    fields.push({ name: 'Activity Graph',  value: '```\n' + graph + '\n```', inline: false });
    fields.push({ name: 'Daily Breakdown', value: '```\n' + table + '\n```', inline: false });
  }

  const description = totalMessages === 0
    ? 'No activity recorded in this server over the last **' + periodLabel + '**.\n> Tracking started from when Izumi was deployed.'
    : 'Server activity for the last **' + periodLabel + '**';

  const embed = new EmbedBuilder()
    .setTitle('Activity Report: ' + user.username)
    .setDescription(description)
    .setThumbnail(user.displayAvatarURL({ dynamic: true }))
    .setColor(0x5865F2)
    .addFields(fields)
    .setFooter({ text: 'Links shared: ' + totalLinks + ' · Mentions sent: ' + totalMentions + ' · Data tracked from bot deployment' })
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bsum_3_'  + user.id).setLabel('3 Days' ).setStyle(days ===  3 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_5_'  + user.id).setLabel('5 Days' ).setStyle(days ===  5 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_10_' + user.id).setLabel('10 Days').setStyle(days === 10 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bsum_14_' + user.id).setLabel('2 Weeks').setStyle(days === 14 ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );

  return { embed, components: [buttons] };
}


client.login(process.env.TOKEN);
