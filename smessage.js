const {
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelType
} = require('discord.js');
const mongoose = require('mongoose');

// ---- Schema ----

const SmessageLogSchema = new mongoose.Schema({
  guildId:      { type: String, required: true },
  guildName:    { type: String, default: '' },
  senderId:     { type: String, required: true },
  senderTag:    { type: String, default: '' },
  recipientId:  { type: String, required: true },
  recipientTag: { type: String, default: '' },
  content:      { type: String, default: '' },
  mediaUrl:     { type: String, default: null },
  sentAt:       { type: Date, default: Date.now }
});
SmessageLogSchema.index({ guildId: 1, senderId: 1 });
SmessageLogSchema.index({ guildId: 1, recipientId: 1 });
const SmessageLogModel = mongoose.model('IzumiSmessageLog', SmessageLogSchema);

// ---- Helpers ----

const URL_REGEX = /^https?:\/\/.+\..+/i;

function isValidUrl(str) {
  return URL_REGEX.test(str.trim());
}

// Determine whether the URL is likely an image/gif we can embed
function isEmbeddableMedia(url) {
  return /\.(gif|png|jpe?g|webp|bmp|svg)(\?.*)?$/i.test(url) ||
    /tenor\.com|giphy\.com|media\.discordapp|cdn\.discordapp|imgur\.com/i.test(url);
}

// ---- /smessage — open the compose modal ----

async function handleSmessageCommand(interaction) {
  const target = interaction.options.getUser('user');

  if (!target) {
    return interaction.reply({ content: 'Please specify a user to whisper.', ephemeral: true });
  }

  if (target.id === interaction.user.id) {
    return interaction.reply({ content: 'You cannot whisper yourself.', ephemeral: true });
  }

  if (target.bot) {
    return interaction.reply({ content: 'You cannot whisper a bot.', ephemeral: true });
  }

  // Confirm the target is actually in this guild
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`smessage_compose_${target.id}_${interaction.guild.id}`)
    .setTitle(`Whisper to ${target.username}`);

  const contentInput = new TextInputBuilder()
    .setCustomId('smessage_content')
    .setLabel('Message')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Type your whisper here…')
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(1500);

  const mediaInput = new TextInputBuilder()
    .setCustomId('smessage_media')
    .setLabel('Media URL (image / GIF — optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://tenor.com/… or any direct image link')
    .setRequired(false)
    .setMaxLength(512);

  modal.addComponents(
    new ActionRowBuilder().addComponents(contentInput),
    new ActionRowBuilder().addComponents(mediaInput)
  );

  await interaction.showModal(modal);
}

// ---- Modal submission — deliver the whisper ----

async function handleSmessageModal(interaction, client, serverConfigs) {
  // customId: smessage_compose_<recipientId>_<guildId>
  const parts = interaction.customId.replace('smessage_compose_', '').split('_');
  // Guild IDs can contain underscores — split from the end is safer
  // Format is always: smessage_compose_{recipientId}_{guildId}
  // Both IDs are pure digits, so we split on '_' and take first as recipientId, rest joined as guildId
  const recipientId = parts[0];
  const guildId = parts.slice(1).join('_');

  const content = interaction.fields.getTextInputValue('smessage_content').trim();
  const rawMedia = interaction.fields.getTextInputValue('smessage_media')?.trim() || '';
  const mediaUrl = rawMedia.length > 0 ? rawMedia : null;

  // Validate media URL if provided
  if (mediaUrl && !isValidUrl(mediaUrl)) {
    return interaction.reply({
      content: 'The media URL you provided doesn\'t look valid. Please use a full URL starting with `https://`.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const sender = interaction.user;
  const guild  = interaction.guild;

  // Resolve recipient
  let recipient;
  try {
    recipient = await client.users.fetch(recipientId);
  } catch {
    return interaction.editReply({ content: 'Could not resolve the recipient user. They may have left Discord.' });
  }

  // ---- Build recipient embed ----
  const recipientEmbed = new EmbedBuilder()
    .setAuthor({
      name: `Whisper from ${sender.username}`,
      iconURL: sender.displayAvatarURL({ dynamic: true, size: 256 })
    })
    .setTitle('📩  You have received a whisper')
    .setDescription(content)
    .setColor(0x9B59B6)
    .setFooter({
      text: `Sent from ${guild.name}  •  This message is read-only`,
      iconURL: guild.iconURL({ dynamic: true }) ?? undefined
    })
    .setTimestamp();

  if (mediaUrl) {
    if (isEmbeddableMedia(mediaUrl)) {
      recipientEmbed.setImage(mediaUrl);
    } else {
      // Attach as a link field for non-embeddable URLs
      recipientEmbed.addFields({ name: 'Attached link', value: mediaUrl, inline: false });
    }
  }

  // ---- Send to recipient via DM ----
  let delivered = false;
  let deliveryError = null;
  try {
    const dmChannel = await recipient.createDM();
    await dmChannel.send({ embeds: [recipientEmbed] });
    delivered = true;
  } catch (err) {
    deliveryError = err.message ?? 'Unknown error';
  }

  if (!delivered) {
    return interaction.editReply({
      content: `❌ Could not deliver your whisper to **${recipient.username}**. They may have DMs disabled or have blocked the bot.`,
    });
  }

  // ---- Sender confirmation (ephemeral) ----
  const confirmEmbed = new EmbedBuilder()
    .setTitle('✅  Whisper sent')
    .setDescription(`Your whisper was delivered to **${recipient.username}**.`)
    .addFields(
      { name: 'Recipient', value: `${recipient} (${recipient.id})`, inline: true },
      { name: 'Preview', value: content.length > 300 ? content.slice(0, 297) + '…' : content, inline: false }
    )
    .setColor(0x57F287)
    .setTimestamp();

  if (mediaUrl) {
    confirmEmbed.addFields({ name: 'Media', value: mediaUrl, inline: false });
  }

  await interaction.editReply({ embeds: [confirmEmbed] });

  // ---- Mod log ----
  const cfg = serverConfigs.get(guildId);
  const logChannelId = cfg?.smessageLogsChannel ?? null;

  if (logChannelId) {
    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel) {
      const logEmbed = new EmbedBuilder()
        .setTitle('🔍  Whisper Log')
        .setColor(0x2C3E50)
        .setThumbnail(sender.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: 'Sender',    value: `${sender} (${sender.id})\n\`${sender.tag}\``,        inline: true },
          { name: 'Recipient', value: `${recipient} (${recipient.id})\n\`${recipient.tag}\``, inline: true },
          { name: '\u200B',    value: '\u200B', inline: true },
          { name: 'Message content', value: content, inline: false }
        )
        .setFooter({ text: `Guild: ${guild.name} (${guild.id})` })
        .setTimestamp();

      if (mediaUrl) {
        logEmbed.addFields({ name: 'Media URL', value: mediaUrl, inline: false });
        if (isEmbeddableMedia(mediaUrl)) {
          logEmbed.setImage(mediaUrl);
        }
      }

      await logChannel.send({ embeds: [logEmbed] }).catch(console.error);
    }
  }

  // ---- Persist log to DB ----
  SmessageLogModel.create({
    guildId:      guild.id,
    guildName:    guild.name,
    senderId:     sender.id,
    senderTag:    sender.tag,
    recipientId:  recipient.id,
    recipientTag: recipient.tag,
    content,
    mediaUrl: mediaUrl ?? null
  }).catch(console.error);
}

// ---- /setsmessagelogs — configure the log channel ----

async function handleSetSmessageLogsCommand(interaction) {
  const guild = interaction.guild;

  const textChannels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .first(25);

  const options = textChannels.map(c => ({
    label: `#${c.name}`,
    value: c.id,
    description: 'Set as smessage log channel'
  }));

  if (options.length === 0) {
    options.push({
      label: 'No text channels available',
      value: 'none',
      description: 'Create a text channel first'
    });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_smessage_logs_${guild.id}`)
    .setPlaceholder('Choose a channel for whisper logs')
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setTitle('Configure Whisper (Smessage) Logs')
    .setDescription(
      'Select a **staff-only channel** where all `/smessage` whispers will be logged.\n\n' +
      'Each log entry shows the sender, recipient, full message content, and any attached media.'
    )
    .setColor(0x9B59B6);

  return interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    ephemeral: false
  });
}

module.exports = {
  handleSmessageCommand,
  handleSmessageModal,
  handleSetSmessageLogsCommand
};
