const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  escapeMarkdown
} = require('discord.js');
const mongoose = require('mongoose');

// ---- Schemas ----

const TicketConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  panelMessageId: { type: String, default: null },
  caption: { type: String, default: 'Open a ticket and our team will assist you.' },
  allowedRoles: { type: [String], default: [] },
  transcriptChannelId: { type: String, default: null }
});
const TicketConfigModel = mongoose.model('IzumiTicketConfig', TicketConfigSchema);

const ActiveTicketSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  creatorId: { type: String, required: true },
  locked: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  transcriptSaved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const ActiveTicketModel = mongoose.model('IzumiActiveTicket', ActiveTicketSchema);

// Per-user ticket creation cooldown (in-memory — intentionally resets on restart)
const ticketCooldowns = new Map();
const TICKET_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// DB-backed setup state — survives bot restarts and redeployments
const TicketSetupStateSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, default: null },
  caption: { type: String, default: null },
  allowedRoles: { type: [String], default: [] },
  updatedAt: { type: Date, default: Date.now }
});
const TicketSetupStateModel = mongoose.model('IzumiTicketSetupState', TicketSetupStateSchema);

// Stored transcripts for paginated embed navigation
const TranscriptSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelName: { type: String, required: true },
  creatorId: { type: String, required: true },
  creatorName: { type: String, default: null },
  closedById: { type: String, default: null },
  closedByName: { type: String, default: null },
  pages: { type: [String], required: true },
  totalMessages: { type: Number, default: 0 },
  openedAt: { type: Date, default: null },
  savedAt: { type: Date, default: Date.now }
});
const TranscriptModel = mongoose.model('IzumiTranscript', TranscriptSchema);

// ---- Transcript helpers ----

const PAGE_LIMIT = 3800;

function buildPages(messages) {
  const pad = n => String(n).padStart(2, '0');
  const pages = [];
  let current = '';

  for (const m of messages) {
    const d = new Date(m.createdTimestamp);
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const author = m.author ? escapeMarkdown(m.author.username) : 'Unknown';

    let content = m.content || '';
    if (m.attachments.size > 0) {
      content += (content ? ' ' : '') + `[${m.attachments.size} attachment(s)]`;
    }
    if (!content && m.embeds.length > 0) content = '[embed]';
    if (!content) content = '[no content]';
    if (content.length > 350) content = content.slice(0, 347) + '...';

    const line = `\`${time}\` **${author}**: ${content}\n`;

    if (current.length + line.length > PAGE_LIMIT) {
      if (current) pages.push(current);
      current = line;
    } else {
      current += line;
    }
  }

  if (current) pages.push(current);
  if (pages.length === 0) pages.push('*No messages found in this ticket.*');
  return pages;
}

function buildTranscriptEmbed(transcript, pageIndex) {
  const openedAt = transcript.openedAt
    ? Math.floor(new Date(transcript.openedAt).getTime() / 1000)
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`Ticket Transcript — #${transcript.channelName}`)
    .setDescription(transcript.pages[pageIndex])
    .setColor(0x5865F2)
    .addFields(
      {
        name: 'Opened by',
        value: transcript.creatorName
          ? `${transcript.creatorName} (<@${transcript.creatorId}>)`
          : `<@${transcript.creatorId}>`,
        inline: true
      },
      {
        name: 'Closed by',
        value: transcript.closedByName
          ? `${transcript.closedByName} (<@${transcript.closedById}>)`
          : (transcript.closedById ? `<@${transcript.closedById}>` : 'Unknown'),
        inline: true
      },
      { name: 'Messages', value: String(transcript.totalMessages), inline: true }
    )
    .setFooter({ text: `Page ${pageIndex + 1} of ${transcript.pages.length}` })
    .setTimestamp(transcript.savedAt);

  if (openedAt) {
    embed.addFields({ name: 'Ticket opened', value: `<t:${openedAt}:f>`, inline: true });
  }

  return embed;
}

function buildTranscriptNav(transcriptId, currentPage, totalPages) {
  if (totalPages <= 1) return [];
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_tr_prev_${transcriptId}_${currentPage}`)
      .setLabel('< Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`ticket_tr_next_${transcriptId}_${currentPage}`)
      .setLabel('Next >')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1)
  );
  return [row];
}

async function fetchAllMessages(channel) {
  const messages = [];
  let lastId = null;
  for (let i = 0; i < 10; i++) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    let batch;
    try {
      batch = await channel.messages.fetch(options);
    } catch {
      break;
    }
    if (!batch || batch.size === 0) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function postTranscript(guild, channel, ticket, closedByMember) {
  const config = await TicketConfigModel.findOne({ guildId: ticket.guildId });
  const transcriptChannelId = config?.transcriptChannelId;

  const messages = await fetchAllMessages(channel);
  const pages = buildPages(messages);

  // Resolve display names for the embed
  let creatorName = null;
  try {
    const creator = await guild.members.fetch(ticket.creatorId);
    creatorName = creator.user.username;
  } catch {}

  const closedById = closedByMember?.id ?? null;
  const closedByName = closedByMember?.user?.username ?? null;

  const openedAt = ticket.createdAt instanceof Date
    ? ticket.createdAt
    : (ticket.createdAt ? new Date(ticket.createdAt) : null);

  const doc = await TranscriptModel.create({
    guildId: ticket.guildId,
    channelName: channel.name,
    creatorId: ticket.creatorId,
    creatorName,
    closedById,
    closedByName,
    pages,
    totalMessages: messages.length,
    openedAt: openedAt && !isNaN(openedAt) ? openedAt : null
  });

  const transcriptId = doc._id.toString();

  if (transcriptChannelId) {
    const transcriptChan = guild.channels.cache.get(transcriptChannelId);
    if (transcriptChan) {
      const embed = buildTranscriptEmbed(doc, 0);
      const components = buildTranscriptNav(transcriptId, 0, pages.length);
      await transcriptChan.send({ embeds: [embed], components });
      return transcriptChan;
    }
  }

  return null;
}

// ---- Embed builders ----

function buildTicketPanelEmbed(caption) {
  return new EmbedBuilder()
    .setTitle('Support Tickets')
    .setDescription(caption)
    .setColor(0x2B2D31)
    .setFooter({ text: 'A private channel will be created for you and the support team only.' })
    .setTimestamp();
}

// ---- Slash command handler (/setticket) ----

async function handleSetTicketCommand(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'You need the **Manage Server** permission to configure the ticket system.', ephemeral: false });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Ticket System Setup — Step 1 of 4')
    .setDescription(
      'Select the channel where the ticket creation panel will be posted.\n\n' +
      'Members will see an embed and a button in that channel to open a new private ticket with your team.'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Step 1 of 4 — Select a channel' });

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket_setup_chan_${interaction.guild.id}`)
    .setPlaceholder('Select a channel for the ticket panel...')
    .setChannelTypes([ChannelType.GuildText])
    .setMinValues(1)
    .setMaxValues(1);

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(channelSelect)],
    ephemeral: false
  });
}

// ---- Slash command handler (/ticket <subcommand>) ----

async function handleTicketCommand(interaction) {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channel.id;
  const guildId = interaction.guild.id;

  const ticket = await ActiveTicketModel.findOne({ channelId, guildId });

  if (!ticket) {
    await interaction.reply({ content: 'This command can only be used inside an active ticket channel.', ephemeral: false });
    return;
  }

  const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

  // /ticket close — soft close: lock only the creator out, keep channel for staff
  if (subcommand === 'close') {
    if (ticket.closed) {
      await interaction.reply({ content: 'This ticket is already closed.', ephemeral: false });
      return;
    }

    await interaction.deferReply();

    try {
      await interaction.channel.permissionOverwrites.edit(ticket.creatorId, {
        ViewChannel: true,
        SendMessages: false,
        ReadMessageHistory: true
      });
    } catch (e) {
      console.error('Error editing permissions on close:', e);
    }

    await ActiveTicketModel.findOneAndUpdate({ channelId }, { closed: true });

    const closeEmbed = new EmbedBuilder()
      .setTitle('Ticket Closed')
      .setDescription(
        `This ticket was closed by ${interaction.user}.\n\n` +
        `The member can no longer send messages here. Staff may still view and respond.\n\n` +
        `Use **Save Transcript & Delete** to archive this conversation, or **Reopen** to restore member access.`
      )
      .setColor(0xED4245)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_reopen_${channelId}`)
        .setLabel('Reopen')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ticket_transcript_delete_${channelId}`)
        .setLabel('Save Transcript & Delete')
        .setStyle(ButtonStyle.Danger)
    );

    await interaction.editReply({ embeds: [closeEmbed], components: [row] });
    return;
  }

  // /ticket transcript — save transcript embeds to log channel then delete
  if (subcommand === 'transcript') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to save transcripts.', ephemeral: false });
      return;
    }

    await interaction.deferReply();

    try {
      const transcriptChan = await postTranscript(interaction.guild, interaction.channel, ticket, interaction.member);
      await ActiveTicketModel.findOneAndUpdate({ channelId }, { transcriptSaved: true });

      if (transcriptChan) {
        await interaction.editReply({ content: `Transcript saved to ${transcriptChan}. Deleting channel in 5 seconds...` });
      } else {
        await interaction.editReply({ content: `Transcript saved. Note: configure a transcript log channel via \`/setticket\` to have these posted automatically. Deleting channel in 5 seconds...` });
      }

      await new Promise(r => setTimeout(r, 5000));
      await ActiveTicketModel.deleteOne({ channelId }).catch(() => {});
      await interaction.channel.delete('Transcript saved and ticket deleted').catch(() => {});
    } catch (e) {
      console.error('Transcript error:', e);
      await interaction.editReply({ content: `Failed to save transcript: ${e.message}` }).catch(() => {});
    }
    return;
  }

  // /ticket delete — hard delete, warn if no transcript saved
  if (subcommand === 'delete') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to delete tickets.', ephemeral: false });
      return;
    }

    await interaction.deferReply();

    try {
      if (!ticket.transcriptSaved) {
        const config = await TicketConfigModel.findOne({ guildId });
        const transcriptChannelId = config?.transcriptChannelId;
        if (transcriptChannelId) {
          const transcriptChan = interaction.guild.channels.cache.get(transcriptChannelId);
          if (transcriptChan) {
            const warnEmbed = new EmbedBuilder()
              .setTitle('Ticket Deleted Without Transcript')
              .setDescription(
                `A ticket was deleted without saving a transcript.\n\n` +
                `**Channel:** #${interaction.channel.name}\n` +
                `**Opened by:** <@${ticket.creatorId}>\n` +
                `**Deleted by:** ${interaction.user}\n\n` +
                `Deleting tickets without saving a transcript is against transparency policy.`
              )
              .setColor(0xFEE75C)
              .setTimestamp();
            await transcriptChan.send({ embeds: [warnEmbed] }).catch(() => {});
          }
        }
      }

      await interaction.editReply({ content: 'Deleting ticket channel...' });
      await ActiveTicketModel.deleteOne({ channelId }).catch(() => {});
      await interaction.channel.delete('Ticket forcefully deleted').catch(() => {});
    } catch (e) {
      console.error('Delete error:', e);
      await interaction.editReply({ content: `Failed to delete ticket: ${e.message}` }).catch(() => {});
    }
    return;
  }

  // /ticket lock
  if (subcommand === 'lock') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to lock tickets.', ephemeral: false });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(guildId, { SendMessages: false });
    await ActiveTicketModel.findOneAndUpdate({ channelId }, { locked: true });
    await interaction.reply({ content: 'Ticket locked. Members can no longer send messages in this channel.' });
    return;
  }

  // /ticket unlock
  if (subcommand === 'unlock') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to unlock tickets.', ephemeral: false });
      return;
    }
    await interaction.channel.permissionOverwrites.edit(guildId, { SendMessages: null });
    await ActiveTicketModel.findOneAndUpdate({ channelId }, { locked: false, closed: false });
    await interaction.reply({ content: 'Ticket unlocked. Members can now send messages again.' });
    return;
  }

  // /ticket roles
  if (subcommand === 'roles') {
    if (!isStaff) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to reconfigure ticket roles.', ephemeral: false });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Reconfigure Ticket Access')
      .setDescription(
        'Select the roles that should have access to this ticket channel.\n\n' +
        'The ticket creator will always retain access regardless of what is selected here.'
      )
      .setColor(0x5865F2);

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`ticket_cfg_roles_${channelId}`)
      .setPlaceholder('Select roles...')
      .setMinValues(0)
      .setMaxValues(25);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(roleSelect)],
      ephemeral: false
    });
    return;
  }
}

// ---- Main interaction router ----

async function handleTicketInteraction(interaction) {
  const { customId } = interaction;
  if (!customId) return false;

  // Step 1: Channel selected during setup
  if (interaction.isChannelSelectMenu() && customId.startsWith('ticket_setup_chan_')) {
    const guildId = customId.replace('ticket_setup_chan_', '');
    const selectedChannelId = interaction.values[0];

    await TicketSetupStateModel.findOneAndUpdate(
      { guildId },
      { guildId, channelId: selectedChannelId, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    const modal = new ModalBuilder()
      .setCustomId(`ticket_caption_${guildId}`)
      .setTitle('Ticket Setup — Step 2 of 4');

    const captionInput = new TextInputBuilder()
      .setCustomId('caption')
      .setLabel('Caption shown above the Create Ticket button')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('e.g. Need assistance? Open a ticket and our team will respond promptly.')
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(captionInput));
    await interaction.showModal(modal);
    return true;
  }

  // Step 2: Caption modal submitted
  if (interaction.isModalSubmit() && customId.startsWith('ticket_caption_')) {
    const guildId = customId.replace('ticket_caption_', '');
    const caption = interaction.fields.getTextInputValue('caption');

    await TicketSetupStateModel.findOneAndUpdate(
      { guildId },
      { caption, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    const embed = new EmbedBuilder()
      .setTitle('Ticket System Setup — Step 3 of 4')
      .setDescription(
        'Caption saved.\n\n' +
        'Now select which roles will be able to **view and respond** to all tickets.\n' +
        'The member who opens a ticket will always have access to their own ticket channel regardless of this selection.'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Step 3 of 4 — Select support roles' });

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId(`ticket_setup_roles_${guildId}`)
      .setPlaceholder('Select one or more support roles...')
      .setMinValues(1)
      .setMaxValues(25);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(roleSelect)],
      ephemeral: false
    });
    return true;
  }

  // Step 3: Roles selected — save and ask for transcript channel
  if (interaction.isRoleSelectMenu() && customId.startsWith('ticket_setup_roles_')) {
    const guildId = customId.replace('ticket_setup_roles_', '');

    const state = await TicketSetupStateModel.findOne({ guildId });
    if (!state || !state.channelId) {
      await interaction.reply({ content: 'Setup session expired. Please run `/setticket` again.', ephemeral: false });
      return true;
    }

    await TicketSetupStateModel.findOneAndUpdate(
      { guildId },
      { allowedRoles: interaction.values, updatedAt: new Date() }
    );

    const embed = new EmbedBuilder()
      .setTitle('Ticket System Setup — Step 4 of 4')
      .setDescription(
        'Support roles saved.\n\n' +
        'Finally, select a **staff-only channel** where ticket transcripts will be posted when a ticket is closed.\n\n' +
        'Staff will be able to browse through each transcript page by page directly in Discord.'
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Step 4 of 4 — Select transcript log channel' });

    const transcriptChanSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`ticket_setup_transcript_${guildId}`)
      .setPlaceholder('Select a channel for transcript logs...')
      .setChannelTypes([ChannelType.GuildText])
      .setMinValues(1)
      .setMaxValues(1);

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(transcriptChanSelect)],
      ephemeral: false
    });
    return true;
  }

  // Step 4: Transcript channel selected — finalize setup
  if (interaction.isChannelSelectMenu() && customId.startsWith('ticket_setup_transcript_')) {
    const guildId = customId.replace('ticket_setup_transcript_', '');

    const state = await TicketSetupStateModel.findOne({ guildId });
    if (!state || !state.channelId) {
      await interaction.reply({ content: 'Setup session expired. Please run `/setticket` again.', ephemeral: false });
      return true;
    }

    const { channelId, caption, allowedRoles } = state;
    const transcriptChannelId = interaction.values[0];

    // Delete old panel if reconfiguring
    try {
      const existingConfig = await TicketConfigModel.findOne({ guildId });
      if (existingConfig?.panelMessageId) {
        const oldChan = interaction.guild.channels.cache.get(existingConfig.channelId);
        if (oldChan) {
          await oldChan.messages.fetch(existingConfig.panelMessageId).then(m => m.delete()).catch(() => {});
        }
      }
    } catch (_) {}

    const targetChannel = interaction.guild.channels.cache.get(channelId);
    if (!targetChannel) {
      await interaction.reply({
        content: 'The selected panel channel no longer exists. Please run `/setticket` again.',
        ephemeral: false
      });
      return true;
    }

    let panelMsg;
    try {
      const panelEmbed = buildTicketPanelEmbed(caption);
      const createRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_create_${guildId}`)
          .setLabel('Create Ticket')
          .setStyle(ButtonStyle.Primary)
      );
      panelMsg = await targetChannel.send({ embeds: [panelEmbed], components: [createRow] });
    } catch (e) {
      console.error('Ticket panel send error:', e);
      await interaction.reply({
        content: `Failed to post the ticket panel in <#${channelId}>. Make sure I have permission to send messages there.`,
        ephemeral: false
      });
      return true;
    }

    await TicketConfigModel.findOneAndUpdate(
      { guildId },
      { guildId, channelId, caption, allowedRoles, panelMessageId: panelMsg.id, transcriptChannelId },
      { upsert: true, new: true }
    );

    await TicketSetupStateModel.deleteOne({ guildId });

    const rolesMentions = allowedRoles.map(r => `<@&${r}>`).join(', ');
    const confirmEmbed = new EmbedBuilder()
      .setTitle('Ticket System Configured')
      .setDescription(`The ticket panel has been posted in <#${channelId}>. Members can now open tickets.`)
      .addFields(
        { name: 'Caption', value: caption, inline: false },
        { name: 'Support Roles', value: rolesMentions, inline: false },
        { name: 'Transcript Log Channel', value: `<#${transcriptChannelId}>`, inline: false }
      )
      .setColor(0x57F287)
      .setTimestamp();

    await interaction.reply({ embeds: [confirmEmbed], ephemeral: false });
    return true;
  }

  // Create ticket button
  if (interaction.isButton() && customId.startsWith('ticket_create_')) {
    const guildId = customId.replace('ticket_create_', '');
    const config = await TicketConfigModel.findOne({ guildId });

    if (!config) {
      await interaction.reply({ content: 'The ticket system is not properly configured for this server.', ephemeral: false });
      return true;
    }

    // One open ticket per user
    const existingTicket = await ActiveTicketModel.findOne({ guildId, creatorId: interaction.user.id });
    if (existingTicket) {
      await interaction.reply({
        content: `You already have an open ticket: <#${existingTicket.channelId}>. Please continue there, or ask staff to close it before opening a new one.`,
        ephemeral: true
      });
      return true;
    }

    // Cooldown — 10 minutes between ticket creations
    const cooldownKey = `${guildId}_${interaction.user.id}`;
    const now = Date.now();
    const lastCreated = ticketCooldowns.get(cooldownKey);
    if (lastCreated && now - lastCreated < TICKET_COOLDOWN_MS) {
      const remaining = Math.ceil((TICKET_COOLDOWN_MS - (now - lastCreated)) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      await interaction.reply({
        content: `You're creating tickets too quickly. Please wait **${timeStr}** before trying again.`,
        ephemeral: true
      });
      return true;
    }
    ticketCooldowns.set(cooldownKey, now);

    await interaction.deferReply({ ephemeral: false });

    const guild = interaction.guild;
    const creator = interaction.member;
    const botId = guild.members.me ? guild.members.me.id : interaction.client.user.id;

    const safeName =
      'ticket-' +
      (creator.user.username
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 22) || creator.user.id);

    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: creator.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      },
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ];

    for (const roleId of config.allowedRoles) {
      overwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks
        ]
      });
    }

    let ticketChannel;
    try {
      ticketChannel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        topic: `Ticket opened by ${creator.user.tag} — ${creator.user.id}`,
        permissionOverwrites: overwrites
      });
    } catch (e) {
      console.error('Error creating ticket channel:', e);
      await interaction.editReply({ content: 'Failed to create the ticket channel. Please ensure I have the **Manage Channels** permission.' });
      return true;
    }

    const roleMentions = config.allowedRoles.map(r => `<@&${r}>`).join(', ');

    const greetingEmbed = new EmbedBuilder()
      .setTitle('New Ticket — Welcome')
      .setDescription(
        `${creator} — your ticket has been received.\n\n` +
        (roleMentions
          ? `${roleMentions} — a member of the team will be with you shortly. Please describe your matter in the meantime.`
          : 'A member of the team will be with you shortly. Please describe your matter.')
      )
      .setColor(0x5865F2)
      .setTimestamp();

    await ticketChannel.send({ content: roleMentions || null, embeds: [greetingEmbed] });

    await ActiveTicketModel.create({
      guildId,
      channelId: ticketChannel.id,
      creatorId: creator.id,
      locked: false,
      closed: false,
      transcriptSaved: false
    });

    await interaction.editReply({ content: `Your ticket has been created: ${ticketChannel}` });
    return true;
  }

  // Reopen button
  if (interaction.isButton() && customId.startsWith('ticket_reopen_')) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to reopen tickets.', ephemeral: false });
      return true;
    }

    const channelId = customId.replace('ticket_reopen_', '');
    const ticket = await ActiveTicketModel.findOne({ channelId });
    if (!ticket) {
      await interaction.reply({ content: 'Ticket not found.', ephemeral: false });
      return true;
    }

    await interaction.channel.permissionOverwrites.edit(ticket.creatorId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});

    await ActiveTicketModel.findOneAndUpdate({ channelId }, { closed: false });

    const reopenEmbed = new EmbedBuilder()
      .setDescription(`Ticket reopened by ${interaction.user}. The member can send messages again.`)
      .setColor(0x57F287);

    await interaction.update({ embeds: [reopenEmbed], components: [] });
    return true;
  }

  // Save Transcript & Delete button
  if (interaction.isButton() && customId.startsWith('ticket_transcript_delete_')) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'You need the **Manage Server** permission to save transcripts.', ephemeral: false });
      return true;
    }

    const channelId = customId.replace('ticket_transcript_delete_', '');
    const ticket = await ActiveTicketModel.findOne({ channelId });
    if (!ticket) {
      await interaction.reply({ content: 'Ticket not found.', ephemeral: false });
      return true;
    }

    await interaction.deferUpdate();

    try {
      const transcriptChan = await postTranscript(interaction.guild, interaction.channel, ticket, interaction.member);
      await ActiveTicketModel.findOneAndUpdate({ channelId }, { transcriptSaved: true });

      const savedEmbed = new EmbedBuilder()
        .setDescription(`Transcript saved${transcriptChan ? ` in ${transcriptChan}` : ''}. Deleting channel in 5 seconds...`)
        .setColor(0x5865F2);

      await interaction.editReply({ embeds: [savedEmbed], components: [] });
      await new Promise(r => setTimeout(r, 5000));
      await ActiveTicketModel.deleteOne({ channelId }).catch(() => {});
      await interaction.channel.delete('Transcript saved and ticket deleted').catch(() => {});
    } catch (e) {
      console.error('Transcript+delete error:', e);
      await interaction.editReply({ content: `Failed to save transcript: ${e.message}` }).catch(() => {});
    }
    return true;
  }

  // Transcript page navigation — previous
  if (interaction.isButton() && customId.startsWith('ticket_tr_prev_')) {
    const rest = customId.replace('ticket_tr_prev_', '');
    const lastUnderscore = rest.lastIndexOf('_');
    const transcriptId = rest.slice(0, lastUnderscore);
    const currentPage = parseInt(rest.slice(lastUnderscore + 1), 10);

    const transcript = await TranscriptModel.findById(transcriptId);
    if (!transcript) {
      await interaction.reply({ content: 'Transcript not found.', ephemeral: false });
      return true;
    }

    const newPage = Math.max(0, currentPage - 1);
    const embed = buildTranscriptEmbed(transcript, newPage);
    const components = buildTranscriptNav(transcriptId, newPage, transcript.pages.length);
    await interaction.update({ embeds: [embed], components });
    return true;
  }

  // Transcript page navigation — next
  if (interaction.isButton() && customId.startsWith('ticket_tr_next_')) {
    const rest = customId.replace('ticket_tr_next_', '');
    const lastUnderscore = rest.lastIndexOf('_');
    const transcriptId = rest.slice(0, lastUnderscore);
    const currentPage = parseInt(rest.slice(lastUnderscore + 1), 10);

    const transcript = await TranscriptModel.findById(transcriptId);
    if (!transcript) {
      await interaction.reply({ content: 'Transcript not found.', ephemeral: false });
      return true;
    }

    const newPage = Math.min(transcript.pages.length - 1, currentPage + 1);
    const embed = buildTranscriptEmbed(transcript, newPage);
    const components = buildTranscriptNav(transcriptId, newPage, transcript.pages.length);
    await interaction.update({ embeds: [embed], components });
    return true;
  }

  // /ticket roles — role select response
  if (interaction.isRoleSelectMenu() && customId.startsWith('ticket_cfg_roles_')) {
    const channelId = customId.replace('ticket_cfg_roles_', '');
    const ticket = await ActiveTicketModel.findOne({ channelId });
    if (!ticket) {
      await interaction.reply({ content: 'Ticket not found in database.', ephemeral: false });
      return true;
    }

    const ticketChannel = interaction.guild.channels.cache.get(channelId);
    if (!ticketChannel) {
      await interaction.reply({ content: 'Ticket channel not found.', ephemeral: false });
      return true;
    }

    const selectedRoles = interaction.values;
    const botId = interaction.guild.members.me ? interaction.guild.members.me.id : interaction.client.user.id;

    for (const [id] of ticketChannel.permissionOverwrites.cache) {
      const isEveryone = id === interaction.guild.id;
      const isBot = id === botId;
      const isCreator = id === ticket.creatorId;
      if (!isEveryone && !isBot && !isCreator) {
        await ticketChannel.permissionOverwrites.delete(id).catch(() => {});
      }
    }

    for (const roleId of selectedRoles) {
      await ticketChannel.permissionOverwrites.edit(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true
      }).catch(() => {});
    }

    const rolesMentions = selectedRoles.length > 0
      ? selectedRoles.map(r => `<@&${r}>`).join(', ')
      : 'None — only the ticket creator can see this channel now.';

    await interaction.reply({ content: `Ticket access updated. Roles with access: ${rolesMentions}`, ephemeral: false });
    return true;
  }

  return false;
}

async function loadTicketConfigs() {
  const ticketCount = await TicketConfigModel.countDocuments();
  const activeCount = await ActiveTicketModel.countDocuments();
  console.log(`Ticket system: ${ticketCount} config(s), ${activeCount} active ticket(s) loaded.`);
}

module.exports = {
  handleSetTicketCommand,
  handleTicketCommand,
  handleTicketInteraction,
  loadTicketConfigs
};
