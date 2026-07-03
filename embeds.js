const { EmbedBuilder } = require('discord.js');

async function makeCheckEmbed(user, risk, guild) {
  const days = Math.floor(risk.accountAge / (1000 * 60 * 60 * 24));
  const hours = Math.floor((risk.accountAge % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  const colors = {
    'Critical': 0x8B0000,
    'High': 0xFF0000,
    'Medium': 0xFFA500,
    'Low': 0xFFFF00,
    'Minimal': 0x00FF00
  };

  const embed = new EmbedBuilder()
    .setTitle(`[${risk.label}] Izumi on the case. Here is my report:`)
    .setDescription(`**Target:** ${user.tag} (${user.id})`)
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setColor(colors[risk.label] || 0x5865F2)
    .setTimestamp();

  embed.addFields(
    { name: 'Risk Score:', value: `**${risk.score}/100** (${risk.label})`, inline: true },
    { name: 'Confidence:', value: `${risk.confidence}%`, inline: true },
    { name: 'Account Age:', value: `${days}d ${hours}h`, inline: true }
  );

  embed.addFields(
    { name: 'Account Stability:', value: risk.analysis.accountStability, inline: true },
    { name: 'Profile Complete:', value: `${risk.analysis.profileCompleteness}%`, inline: true },
    { name: 'Server Integration:', value: risk.analysis.serverIntegration, inline: true }
  );

  if (risk.joinAnalysis) {
    const timeInfo = risk.joinAnalysis.joinDays > 0 ?
      `${risk.joinAnalysis.joinDays} days ago` :
      `${risk.joinAnalysis.joinHours} hours ago`;

    embed.addFields({
      name: 'Server Credentials:',
      value: `Joined: ${timeInfo}\nRoles: ${risk.joinAnalysis.roles}\nStatus: ${risk.joinAnalysis.permissions}${risk.joinAnalysis.premium ? '\nServer Booster' : ''}`,
      inline: true
    });
  }

  embed.addFields(
    { name: 'Activity Score', value: `${risk.activityScore}/100`, inline: true },
    { name: 'Legitimacy Signs', value: `${risk.legitimacyIndicators}`, inline: true }
  );

  if (risk.mutualAnalysis) {
    const mutualInfo = risk.mutualAnalysis;
    embed.addFields({
      name: 'Mutual Servers:',
      value: `Mutual servers: ${mutualInfo.mutualCount}\n${mutualInfo.hasCloseTimingPattern ? 'Suspicious timing patterns detected' : 'No suspicious timing patterns'}`,
      inline: true
    });

    if (mutualInfo.suspiciousPatterns.length > 0) {
      embed.addFields({
        name: 'Connection Patterns',
        value: mutualInfo.suspiciousPatterns.slice(0, 3).join('\n'),
        inline: false
      });
    }
  }

  if (risk.factors && risk.factors.length > 0) {
    const riskText = risk.factors.slice(0, 10).join('\n');
    embed.addFields({
      name: 'Risk Indicators',
      value: riskText,
      inline: false
    });
  }

  if (risk.positiveIndicators && risk.positiveIndicators.length > 0) {
    const positiveText = risk.positiveIndicators.slice(0, 6).join('\n');
    embed.addFields({
      name: 'Legitimacy Indicators',
      value: positiveText,
      inline: false
    });
  }

  let verdict = '';
  if (risk.score >= 80) {
    verdict = '**CRITICAL RISK** - You should probably do something by this point. Every factor indicates the illegitamacy of this user.';
  } else if (risk.score >= 60) {
    verdict = '**HIGH RISK** - Keep an eye on this user. There is some strange activity there...';
  } else if (risk.score >= 35) {
    verdict = '**MEDIUM RISK** - They might be hiding something. I suggest you have a further look.';
  } else if (risk.score >= 15) {
    verdict = '**LOW RISK** - Eh, it seems fine. Maybe check this user occasionally. Who knows what they might be hiding?';
  } else {
    verdict = '**MINIMAL RISK** - This user seems legitimate. You can trust them. Probably.';
  }

  embed.addFields({
    name: 'Final Assessment',
    value: verdict,
    inline: false
  });

  embed.setFooter({
    text: `Analysis: ${risk.riskIndicators} risk factors  ${risk.legitimacyIndicators} positive signs  Checked by Izumi - Your full-time detective.`,
    iconURL: user.displayAvatarURL({ dynamic: true })
  });

  return embed;
}

module.exports = { makeCheckEmbed };
