async function calculateRisk(user, guild) {
  let score = 0;
  const accountAge = Date.now() - user.createdAt;
  const factors = [];
  let suspiciousBehaviors = [];
  let positiveIndicators = [];

  // Advanced Account Age Analysis with exponential weighting
  const ageDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
  if (ageDays < 1) {
    score += 85;
    factors.push('- Account created less than 24 hours ago');
  } else if (ageDays < 3) {
    score += 70;
    factors.push('- Account less than 3 days old');
  } else if (ageDays < 7) {
    score += 50;
    factors.push('- Account less than 1 week old');
  } else if (ageDays < 30) {
    score += 25;
    factors.push('- Account less than 1 month old');
  } else if (ageDays < 90) {
    score += 10;
    factors.push('- Relatively new account (< 3 months)');
  } else if (ageDays > 365) {
    score -= 5; // Bonus for old accounts
    positiveIndicators.push('- Well-established account (1+ years)');
  }

  // Advanced Profile Analysis
  if (!user.avatar) {
    score += 20;
    factors.push('Using default Discord avatar');
  } else {
    // Check if avatar is animated (Nitro indicator)
    if (user.avatar.startsWith('a_')) {
      score -= 8;
      positiveIndicators.push('- Has animated avatar (Nitro user)');
    }
  }

  // Banner analysis (Nitro feature)
  if (user.banner) {
    score -= 10;
    positiveIndicators.push('- Has custom banner (Nitro user)');
  }

  // Advanced Username Analysis
  const username = user.username.toLowerCase();

  // Suspicious patterns
  if (/^[a-z]+\d{4,}$/.test(username)) {
    score += 35;
    factors.push('- Generic username pattern (name + many numbers)');
  }

  if (/^user\d+$/.test(username)) {
    score += 45;
    factors.push('- Default "user" + numbers pattern');
  }

  if (username.includes('alt') || username.includes('backup') || username.includes('second')) {
    score += 40;
    factors.push('- Username suggests alternative account');
  }

  if (username.includes('temp') || username.includes('throwaway')) {
    score += 50;
    factors.push('- Username suggests temporary account');
  }

  // Random character patterns
  if (/^[a-z]{3,8}\d{3,8}$/.test(username) && !username.includes('real')) {
    score += 30;
    suspiciousBehaviors.push('- Random-looking username pattern');
  }

  // Very short usernames (often taken by alts)
  if (username.length <= 3) {
    score += 25;
    factors.push('- Very short username (3 characters or less)');
  }

  // Extremely long usernames (trying to avoid detection)
  if (username.length >= 25) {
    score += 15;
    factors.push('- Unusually long username');
  }

  // Display name analysis
  if (user.globalName) {
    if (user.globalName.toLowerCase().includes('alt') || user.globalName.toLowerCase().includes('backup')) {
      score += 35;
      factors.push('- Display name suggests alt account');
    }

    if (user.globalName !== user.username) {
      score -= 3; // Small bonus for having custom display name
      positiveIndicators.push('- Has custom display name');
    }
  }

  // Advanced Guild Member Analysis
  let joinAnalysis = null;
  let memberRiskFactors = [];

  try {
    const member = await guild.members.fetch(user.id);
    const joinAge = Date.now() - member.joinedTimestamp;
    const joinHours = Math.floor(joinAge / (1000 * 60 * 60));
    const joinDays = Math.floor(joinAge / (1000 * 60 * 60 * 24));

    // Join timing analysis
    if (joinAge < 1000 * 60 * 10) { // Less than 10 minutes
      score += 35;
      factors.push('- Joined server extremely recently (< 10 minutes)');
    } else if (joinAge < 1000 * 60 * 60) { // Less than 1 hour
      score += 25;
      factors.push('- Joined server very recently (< 1 hour)');
    } else if (joinAge < 1000 * 60 * 60 * 24) { // Less than 1 day
      score += 15;
      factors.push('- Joined server recently (< 24 hours)');
    }

    // Role analysis
    const roleCount = member.roles.cache.size - 1; // Exclude @everyone
    if (roleCount === 0) {
      score += 15;
      factors.push('- No roles assigned');
    } else if (roleCount >= 3) {
      score -= 5;
      positiveIndicators.push('- Has multiple roles');
    }

    // Activity indicators
    if (member.premiumSince) {
      score -= 15;
      positiveIndicators.push('- Server booster (shows investment)');
    }

    // Timeout/mute analysis
    if (member.communicationDisabledUntil && member.communicationDisabledUntil > Date.now()) {
      score += 20;
      suspiciousBehaviors.push('Currently timed out');
    }

    // Permission analysis
    if (member.permissions.has('- Administrator')) {
      score -= 25;
      positiveIndicators.push('- Has administrator permissions');
    } else if (member.permissions.has('ModerateMembers')) {
      score -= 15;
      positiveIndicators.push('- Has moderation permissions');
    }

    joinAnalysis = {
      joinedAt: member.joinedTimestamp,
      roles: roleCount,
      premium: member.premiumSince ? true : false,
      permissions: member.permissions.has('Administrator') ? 'Admin' : 
                  member.permissions.has('ModerateMembers') ? 'Moderator' : 'Member',
      joinHours: joinHours,
      joinDays: joinDays
    };

  } catch (error) {
    score += 10;
    factors.push('User not in server (external check)');
  }

  // Advanced Behavior Pattern Analysis

  // Account creation time analysis (common bot creation times)
  const createdHour = new Date(user.createdAt).getHours();
  if (createdHour >= 2 && createdHour <= 6) { // 2-6 AM (suspicious timing)
    score += 10;
    suspiciousBehaviors.push('- Account created during unusual hours (2-6 AM)');
  }

  // ID pattern analysis
  const userId = user.id;
  const lastDigits = userId.slice(-4);
  if (lastDigits === '0000' || lastDigits === '1111' || lastDigits === '9999') {
    score += 15;
    factors.push('- Suspicious ID pattern');
  }

  // Discriminator analysis (for older accounts)
  if (user.discriminator && user.discriminator !== '0') {
    if (['0001', '0002', '1337', '6969', '0420'].includes(user.discriminator)) {
      score += 12;
      factors.push('- Common "joke" discriminator');
    }
  }

  // Cross-reference timing patterns
  if (joinAnalysis && ageDays < 7 && joinAnalysis.joinHours < 24) {
    score += 20;
    suspiciousBehaviors.push('- New account immediately joined server');
  }

  // Additional scoring will be applied by mutual server analysis in index.js

  // Calculate additional metrics
  const activityScore = Math.max(0, 100 - score); // Inverse relationship
  const legitimacyIndicators = positiveIndicators.length;
  const riskIndicators = factors.length + suspiciousBehaviors.length;

  // Apply legitimacy bonus
  if (legitimacyIndicators >= 3) {
    score = Math.max(0, score - 10);
    positiveIndicators.push('Multiple legitimacy indicators present');
  }

  // Ensure realistic score distribution
  score = Math.max(0, Math.min(100, score));

  // Advanced risk labeling
  let label;
  if (score >= 80) label = 'Critical';
  else if (score >= 60) label = 'High';
  else if (score >= 35) label = 'Medium';
  else if (score >= 15) label = 'Low';
  else label = 'Minimal';

  // Enhanced confidence calculation
  const dataPoints = factors.length + positiveIndicators.length + suspiciousBehaviors.length;
  const baseConfidence = joinAnalysis ? 85 : 70; // Higher if user is in server
  const confidence = Math.min(95, Math.max(65, baseConfidence + (dataPoints * 2)));

  return { 
    score, 
    label, 
    accountAge, 
    factors: [...factors, ...suspiciousBehaviors],
    positiveIndicators,
    joinAnalysis,
    confidence,
    activityScore,
    legitimacyIndicators,
    riskIndicators,
    ageDays,
    analysis: {
      accountStability: ageDays > 90 ? 'Stable' : ageDays > 30 ? 'Moderate' : 'Unstable',
      profileCompleteness: (user.avatar ? 25 : 0) + (user.banner ? 25 : 0) + (user.globalName ? 25 : 0) + (joinAnalysis?.roles > 0 ? 25 : 0),
      serverIntegration: joinAnalysis ? (joinAnalysis.roles > 2 ? 'High' : joinAnalysis.roles > 0 ? 'Medium' : 'Low') : 'None'
    }
  };
}

module.exports = { calculateRisk };
