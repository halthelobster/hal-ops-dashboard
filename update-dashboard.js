#!/usr/bin/env node
/**
 * Dashboard Data Updater
 * Collects current state from various sources and updates dashboard files.
 * 
 * Features:
 * - Cron job health monitoring
 * - Things 3 task integration
 * - Activity log tracking (what Hal did overnight)
 * - Active agent/subagent status panel
 * - Auto-updates dashboard HTML with live data
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = '/Users/Hal/clawd';
const DASHBOARD_DIR = path.join(WORKSPACE, 'dashboard');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const ACTIVITY_LOG_PATH = path.join(DASHBOARD_DIR, 'activity-log.json');
const LIFE_VTO_PATH = path.join(WORKSPACE, 'notes/projects/life-vto.md');
const AWAITING_RESPONSES_PATH = path.join(WORKSPACE, 'notes/areas/awaiting-responses.md');
const APPROVAL_QUEUE_PATH = path.join(DASHBOARD_DIR, 'approval-queue.json');
const MAX_ACTIVITY_ITEMS = 50;

const DRY_RUN = process.argv.includes('--dry-run');

// =============================================================================
// DATA COLLECTION
// =============================================================================

// =============================================================================
// NEEDS YOU DATA (Awaiting Responses + Approval Queue + High-Priority Tasks)
// =============================================================================

function getAwaitingResponses() {
  console.log('📨 Collecting awaiting responses...');
  try {
    const content = fs.readFileSync(AWAITING_RESPONSES_PATH, 'utf8');
    const activeSection = content.match(/## Active\s*([\s\S]*?)(?=## Closed|$)/);
    if (!activeSection) return [];
    
    const items = [];
    const lines = activeSection[1].split('\n');
    let currentItem = null;
    
    for (const line of lines) {
      // Match active items: - [ ] [DATE TIME] [CHANNEL] ...
      const itemMatch = line.match(/^- \[ \] \[([^\]]+)\] \[([^\]]+)\] (.+)/);
      if (itemMatch) {
        if (currentItem) items.push(currentItem);
        currentItem = {
          date: itemMatch[1],
          channel: itemMatch[2],
          title: itemMatch[3].substring(0, 80),
          type: 'awaiting',
          whereToCheck: null
        };
      } else if (currentItem && line.includes('Where to check:')) {
        currentItem.whereToCheck = line.replace(/.*Where to check:\s*/, '').trim();
      } else if (currentItem && line.includes('**Checked')) {
        // Extract last check status
        const checkMatch = line.match(/\*\*Checked ([^*]+)\*\*:\s*(.+)/);
        if (checkMatch) {
          currentItem.lastChecked = checkMatch[1];
          currentItem.status = checkMatch[2].substring(0, 60);
        }
      }
    }
    if (currentItem) items.push(currentItem);
    
    console.log(`   Found ${items.length} awaiting responses`);
    return items;
  } catch (err) {
    console.log(`   ⚠️ Failed to read awaiting responses: ${err.message}`);
    return [];
  }
}

function getApprovalQueueItems() {
  console.log('✅ Collecting approval queue items...');
  try {
    const data = JSON.parse(fs.readFileSync(APPROVAL_QUEUE_PATH, 'utf8'));
    const items = (data.pendingApproval || []).map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      type: 'approval',
      addedAt: item.addedAt
    }));
    console.log(`   Found ${items.length} pending approvals`);
    return items;
  } catch (err) {
    console.log(`   ⚠️ Failed to read approval queue: ${err.message}`);
    return [];
  }
}

function getHighPriorityTasks() {
  console.log('⚡ Getting high-priority Things tasks...');
  try {
    // Get today tasks that are tagged or have priority indicators
    const output = execSync('things today 2>/dev/null | head -20', { encoding: 'utf8', timeout: 10000 });
    const lines = output.trim().split('\n').slice(1);
    
    const highPriority = lines
      .map(line => {
        const parts = line.split(/\t/);
        if (parts.length < 2) return null;
        return {
          title: parts[1]?.trim(),
          project: parts[2]?.trim() || parts[3]?.trim() || null,
          type: 'task'
        };
      })
      .filter(Boolean)
      .slice(0, 3); // Top 3 tasks
    
    console.log(`   Found ${highPriority.length} priority tasks`);
    return highPriority;
  } catch (err) {
    console.log(`   ⚠️ Failed to get priority tasks: ${err.message}`);
    return [];
  }
}

function getSystemStatus() {
  console.log('🖥️ Collecting system status...');
  const status = {
    clawdbotVersion: 'unknown',
    mainSessionContext: null,
    memoryFileSize: 0,
    notesFileCount: 0,
    dailyLogsCount: 0
  };
  
  try {
    // Get Clawdbot version
    const versionOutput = execSync('clawdbot --version 2>/dev/null || echo "unknown"', { encoding: 'utf8', timeout: 5000 });
    status.clawdbotVersion = versionOutput.trim().replace(/^clawdbot\s+/i, '');
  } catch (err) {
    status.clawdbotVersion = 'unknown';
  }
  
  try {
    // Get main session context usage from sessions list
    const sessionsOutput = execSync('clawdbot sessions list --json --active 60 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
    const sessionsData = JSON.parse(sessionsOutput);
    const mainSession = (sessionsData.sessions || []).find(s => s.key === 'agent:main:main');
    if (mainSession && mainSession.totalTokens && mainSession.contextTokens) {
      status.mainSessionContext = {
        used: mainSession.totalTokens,
        total: mainSession.contextTokens,
        percent: Math.round((mainSession.totalTokens / mainSession.contextTokens) * 100)
      };
    }
  } catch (err) {
    // Silent fail
  }
  
  try {
    // Count memory files and total size
    const memoryFiles = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    status.dailyLogsCount = memoryFiles.length;
    
    let totalSize = 0;
    for (const file of memoryFiles) {
      const stat = fs.statSync(path.join(MEMORY_DIR, file));
      totalSize += stat.size;
    }
    status.memoryFileSize = Math.round(totalSize / 1024); // KB
  } catch (err) {
    // Silent fail
  }
  
  try {
    // Count notes files
    const countNotes = (dir) => {
      let count = 0;
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          count += countNotes(fullPath);
        } else if (item.endsWith('.md')) {
          count++;
        }
      }
      return count;
    };
    status.notesFileCount = countNotes(path.join(WORKSPACE, 'notes'));
  } catch (err) {
    // Silent fail
  }
  
  console.log(`   Clawdbot: v${status.clawdbotVersion}, Context: ${status.mainSessionContext?.percent || '?'}%, Memory: ${status.memoryFileSize}KB`);
  return status;
}

function getCronDetailedStatus() {
  console.log('📋 Collecting detailed cron status...');
  try {
    const output = execSync('clawdbot cron list', { encoding: 'utf8', timeout: 30000 });
    const lines = output.trim().split('\n').slice(1);
    
    const crons = lines.map(line => {
      const id = line.substring(0, 36).trim();
      const name = line.substring(37, 61).trim();
      const schedule = line.substring(61, 94).trim();
      const next = line.substring(94, 105).trim();
      const last = line.substring(105, 116).trim();
      const status = line.substring(116, 126).trim().toLowerCase();
      
      if (!id || !name) return null;
      
      // Determine color based on status
      let color = 'green';
      if (status === 'error') color = 'red';
      else if (status === 'running') color = 'blue';
      else if (last === '-' || last === 'never') color = 'orange';
      
      return { 
        id, 
        name, 
        schedule, 
        next, 
        last,
        status: status || 'unknown',
        color
      };
    }).filter(Boolean);
    
    const healthy = crons.filter(c => c.status === 'ok' || c.status === 'idle').length;
    const errors = crons.filter(c => c.status === 'error');
    const neverRun = crons.filter(c => c.last === '-' || c.last === 'never');
    
    console.log(`   Found ${crons.length} crons (${healthy} healthy, ${errors.length} errors, ${neverRun.length} never run)`);
    return { crons, healthy, total: crons.length, errors, neverRun };
  } catch (err) {
    console.log(`   ⚠️ Failed to get cron status: ${err.message}`);
    return { crons: [], healthy: 0, total: 0, errors: [], neverRun: [] };
  }
}

function getLifeOSData() {
  console.log('🌟 Collecting Life OS data from life-vto.md...');
  try {
    const content = fs.readFileSync(LIFE_VTO_PATH, 'utf8');
    
    // Parse Q1 2026 Rocks - look for the rocks section and extract table rows
    const rocks = [];
    const rocksSection = content.match(/### 6\. ROCKS[\s\S]*?(?=###|$)/);
    if (rocksSection) {
      const lines = rocksSection[0].split('\n');
      for (const line of lines) {
        // Match lines like: | 1 | Land 1 new consulting client (non-WB) | Jordan | ☐ |
        if (line.match(/^\|\s*\d+\s*\|/)) {
          const parts = line.split('|').map(p => p.trim()).filter(Boolean);
          if (parts.length >= 4) {
            rocks.push({
              number: parseInt(parts[0]) || rocks.length + 1,
              description: parts[1],
              owner: parts[2],
              done: parts[3].includes('☑') || parts[3].includes('✓') || parts[3].toLowerCase() === 'yes' || parts[3].toLowerCase() === 'done'
            });
          }
        }
      }
    }
    
    // Parse Weekly Scorecard metrics
    const scorecard = [];
    const scorecardSection = content.match(/### 7\. WEEKLY SCORECARD[\s\S]*?(?=###|$)/);
    if (scorecardSection) {
      const lines = scorecardSection[0].split('\n');
      for (const line of lines) {
        // Match metric rows - lines starting with | but not header or separator
        if (line.startsWith('|') && !line.includes('Metric') && !line.match(/^\|[-\s|]+\|$/)) {
          const parts = line.split('|').map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2 && parts[0] && !parts[0].match(/^[-]+$/)) {
            scorecard.push({
              metric: parts[0],
              target: parts[1] || '',
              actual: parts[2] || ''
            });
          }
        }
      }
    }
    
    // Parse 1-Year Goals for progress calculation
    const goals = {
      income: { target: '$400K+ total, $150K+ non-WB', progress: 0 },
      body: { target: 'Hit 172-175 (cut)', progress: 0 },
      relationship: { target: 'Dating consistently OR in relationship', progress: 0 },
      freedom: { target: '2+ multi-day sailing trips', progress: 0 },
      lifeQuality: { target: 'Perform at 3+ open mics', progress: 0 }
    };
    
    // Calculate rock completion progress
    const rocksCompleted = rocks.filter(r => r.done).length;
    const rocksTotal = rocks.length;
    const rockProgress = rocksTotal > 0 ? Math.round((rocksCompleted / rocksTotal) * 100) : 0;
    
    // Map rocks to goal areas for progress calculation
    // Rock 1: Land client (Income)
    // Rock 2: Website (Income)
    // Rock 3: LinkedIn (Income/Freedom)
    // Rock 4: Weight 175 (Body)
    // Rock 5: Speaking gig (Income/Freedom)
    // Rock 6: 3+ dates (Relationship)
    // Rock 7: Reach out to colleagues (Freedom)
    // Rock 8: Playmakers Guild (Income)
    
    const incomeRocks = rocks.filter(r => [1, 2, 3, 5, 8].includes(r.number));
    const bodyRocks = rocks.filter(r => [4].includes(r.number));
    const relationshipRocks = rocks.filter(r => [6].includes(r.number));
    const freedomRocks = rocks.filter(r => [3, 5, 7].includes(r.number));
    
    goals.income.progress = Math.round((incomeRocks.filter(r => r.done).length / incomeRocks.length) * 100) || 0;
    goals.body.progress = Math.round((bodyRocks.filter(r => r.done).length / bodyRocks.length) * 100) || 0;
    goals.relationship.progress = Math.round((relationshipRocks.filter(r => r.done).length / relationshipRocks.length) * 100) || 0;
    goals.freedom.progress = Math.round((freedomRocks.filter(r => r.done).length / freedomRocks.length) * 100) || 0;
    goals.lifeQuality.progress = 60; // Keep as qualitative for now
    
    // Calculate days until Q1 ends (March 31, 2026)
    const q1End = new Date('2026-03-31');
    const now = new Date();
    const daysUntilQ1End = Math.ceil((q1End - now) / (1000 * 60 * 60 * 24));
    
    console.log(`   Found ${rocks.length} rocks (${rocksCompleted} done), ${scorecard.length} scorecard metrics`);
    console.log(`   Q1 ends in ${daysUntilQ1End} days`);
    
    return {
      rocks,
      scorecard,
      goals,
      rockProgress,
      rocksCompleted,
      rocksTotal,
      daysUntilQ1End
    };
  } catch (err) {
    console.log(`   ⚠️ Failed to parse life-vto.md: ${err.message}`);
    return {
      rocks: [],
      scorecard: [],
      goals: {},
      rockProgress: 0,
      rocksCompleted: 0,
      rocksTotal: 0,
      daysUntilQ1End: 60
    };
  }
}

function getThingsTaskCounts() {
  console.log('📊 Getting Things 3 task counts...');
  try {
    const todayOutput = execSync('things today 2>/dev/null | tail -n +2 | wc -l', { encoding: 'utf8', timeout: 10000 });
    const inboxOutput = execSync('things inbox 2>/dev/null | tail -n +2 | wc -l', { encoding: 'utf8', timeout: 10000 });
    
    const todayCount = parseInt(todayOutput.trim()) || 0;
    const inboxCount = parseInt(inboxOutput.trim()) || 0;
    
    console.log(`   Today: ${todayCount} tasks, Inbox: ${inboxCount} tasks`);
    return { today: todayCount, inbox: inboxCount, total: todayCount + inboxCount };
  } catch (err) {
    console.log(`   ⚠️ Failed to get task counts: ${err.message}`);
    return { today: 0, inbox: 0, total: 0 };
  }
}

function getOuraBodyStats() {
  console.log('💪 Collecting Oura body stats...');
  try {
    const output = execSync('/Users/Hal/clawd/scripts/get-oura-body-stats.sh', { 
      encoding: 'utf8', 
      timeout: 60000 
    });
    const data = JSON.parse(output.trim());
    
    // Parse resilience: "adequate|52.2|49.2|40.6"
    const [resLevel, sleepRec, dayRec, stressContrib] = (data.resilience || '').split('|');
    
    // Parse stress: "stressful|15300|5400"
    const [stressSummary, stressHigh, recoveryHigh] = (data.stress || '').split('|');
    
    // Parse VO2: "37|2026-01-26"
    const [vo2, vo2Date] = (data.vo2 || '').split('|');
    const prevVo2 = parseInt(data.prevVo2) || 0;
    const currentVo2 = parseInt(vo2) || 0;
    
    // Calculate VO2 trend
    let vo2Trend = '';
    if (currentVo2 > prevVo2) vo2Trend = '↑';
    else if (currentVo2 < prevVo2) vo2Trend = '↓';
    else vo2Trend = '→';
    
    const result = {
      resilience: {
        level: resLevel || 'unknown',
        sleepRecovery: parseFloat(sleepRec) || 0,
        daytimeRecovery: parseFloat(dayRec) || 0,
        stress: parseFloat(stressContrib) || 0
      },
      stress: {
        summary: stressSummary || 'unknown',
        stressMinutes: parseInt(stressHigh) || 0,
        recoveryMinutes: parseInt(recoveryHigh) || 0
      },
      vo2: {
        current: currentVo2,
        previous: prevVo2,
        trend: vo2Trend,
        date: vo2Date
      }
    };
    
    console.log(`   Resilience: ${result.resilience.level}, Stress: ${result.stress.summary}, VO2: ${result.vo2.current} ${result.vo2.trend}`);
    return result;
  } catch (err) {
    console.log(`   ⚠️ Failed to get Oura stats: ${err.message}`);
    return {
      resilience: { level: 'unknown' },
      stress: { summary: 'unknown' },
      vo2: { current: 0, trend: '' }
    };
  }
}

function getCronStatus() {
  console.log('📋 Collecting cron status...');
  try {
    const output = execSync('clawdbot cron list', { encoding: 'utf8', timeout: 30000 });
    const lines = output.trim().split('\n').slice(1); // Skip header
    
    const crons = lines.map(line => {
      // Parse fixed-width columns from clawdbot cron list
      const id = line.substring(0, 36).trim();
      const name = line.substring(37, 61).trim();
      const schedule = line.substring(61, 94).trim();
      const next = line.substring(94, 105).trim();
      const last = line.substring(105, 116).trim();
      const status = line.substring(116, 126).trim().toLowerCase();
      
      if (!id || !name) return null;
      
      return { id, name, schedule, next, last, status: status || 'unknown' };
    }).filter(Boolean);
    
    const healthy = crons.filter(c => c.status === 'ok' || c.status === 'idle').length;
    const errors = crons.filter(c => c.status === 'error');
    
    console.log(`   Found ${crons.length} crons (${healthy} healthy, ${errors.length} errors)`);
    return { crons, healthy, total: crons.length, errors };
  } catch (err) {
    console.log(`   ⚠️ Failed to get cron status: ${err.message}`);
    return { crons: [], healthy: 0, total: 0, errors: [] };
  }
}

function getThingsTasks() {
  console.log('📝 Collecting Things 3 tasks...');
  try {
    const output = execSync('things today', { encoding: 'utf8', timeout: 30000 });
    const lines = output.trim().split('\n').slice(1); // Skip header
    
    const tasks = lines.map(line => {
      const parts = line.split(/\t/);
      if (parts.length < 2) return null;
      
      return {
        uuid: parts[0]?.trim(),
        title: parts[1]?.trim(),
        project: parts[2]?.trim() || null,
        area: parts[3]?.trim() || null,
        status: parts[5]?.trim() || 'incomplete'
      };
    }).filter(Boolean);
    
    console.log(`   Found ${tasks.length} tasks`);
    return tasks;
  } catch (err) {
    console.log(`   ⚠️ Failed to get Things tasks: ${err.message}`);
    return [];
  }
}

function parseAge(ageStr) {
  // Parse age strings like "just now", "1m", "2m", "1h ago", "3h ago", "1d ago"
  if (!ageStr) return 9999;
  if (ageStr === 'just now') return 0;
  
  // Match patterns like "1m", "2h ago", "3d ago"
  const match = ageStr.match(/(\d+)(m|h|d)/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'm') return num;
    if (unit === 'h') return num * 60;
    if (unit === 'd') return num * 60 * 24;
  }
  return 9999;
}

function getActiveAgents() {
  console.log('🤖 Checking active agents/sessions...');
  try {
    // Use JSON output to get full session data
    const output = execSync('clawdbot sessions list --json --active 60 2>/dev/null || echo "{}"', { 
      encoding: 'utf8', 
      timeout: 10000 
    });
    
    let data = {};
    try {
      data = JSON.parse(output);
    } catch (e) {
      console.log('   ⚠️ Could not parse JSON, falling back to empty');
      return { all: [], active: [], count: 1 };
    }
    
    // JSON has { sessions: [...] } wrapper
    const sessions = data.sessions || [];
    
    // Load session labels directly from Clawdbot sessions store
    let sessionLabels = {};
    try {
      const sessionsPath = '/Users/Hal/.clawdbot/agents/main/sessions/sessions.json';
      if (fs.existsSync(sessionsPath)) {
        const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
        for (const [key, value] of Object.entries(sessionsData)) {
          if (value.label) {
            sessionLabels[key] = value.label;
          }
        }
      }
    } catch (e) {
      // Silent fail on sessions file
    }
    
    const agents = sessions.map(s => {
      const key = s.key || '';
      
      // Determine agent type and name from key
      let agentType = 'unknown';
      let agentName = s.label || key; // Use label if available!
      
      // Get label from sessions store
      const sessionLabel = sessionLabels[key];
      
      if (key.includes(':cron:')) {
        agentType = 'cron';
        // Use label if available, otherwise extract cron name from key
        const cronName = sessionLabel || key.split(':cron:')[1] || 'Cron job';
        agentName = cronName;
      } else if (key.includes(':subag')) {
        agentType = 'subagent';
        // Use session label (this is the task description!)
        agentName = sessionLabel || 'Sub-agent';
      } else if (key === 'agent:main:main') {
        agentType = 'main';
        agentName = 'Main session';
      } else if (key.includes(':slack')) {
        agentType = 'slack';
        agentName = sessionLabel || 'Slack session';
      }
      
      // Calculate age from updatedAt
      const updatedAt = s.updatedAt ? new Date(s.updatedAt) : new Date();
      const ageMs = Date.now() - updatedAt.getTime();
      const ageMinutes = Math.floor(ageMs / 60000);
      let age = 'just now';
      if (ageMinutes >= 1440) age = `${Math.floor(ageMinutes / 1440)}d ago`;
      else if (ageMinutes >= 60) age = `${Math.floor(ageMinutes / 60)}h ago`;
      else if (ageMinutes >= 1) age = `${ageMinutes}m`;
      
      // Token usage
      let tokenUsage = null;
      if (s.totalTokens && s.contextTokens) {
        const percent = Math.round((s.totalTokens / s.contextTokens) * 100);
        tokenUsage = {
          used: `${Math.round(s.totalTokens / 1000)}k`,
          total: `${Math.round(s.contextTokens / 1000)}k`,
          percent
        };
      }
      
      const isActive = ageMinutes < 30;
      
      return {
        key,
        kind: s.kind || 'unknown',
        agentType,
        agentName,
        age,
        model: s.model,
        tokenUsage,
        isActive
      };
    });
    
    // Filter to show meaningful agents
    const activeAgents = agents.filter(a => a.isActive || a.agentType === 'main' || a.agentType === 'subagent');
    const runningCount = agents.filter(a => a.isActive).length;
    
    console.log(`   Found ${agents.length} sessions, ${runningCount} active`);
    return { all: agents, active: activeAgents, count: runningCount };
  } catch (err) {
    console.log(`   ⚠️ Failed to get sessions: ${err.message}`);
    return { all: [], active: [], count: 1 };
  }
}

function getRecentDailyLogs() {
  console.log('📖 Collecting recent daily logs...');
  try {
    const today = new Date();
    const logs = [];
    
    // Get last 3 days
    for (let i = 0; i < 3; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const logPath = path.join(MEMORY_DIR, `${dateStr}.md`);
      
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        const title = content.split('\n')[0]?.replace(/^#\s*/, '') || dateStr;
        logs.push({ date: dateStr, title, path: logPath });
      }
    }
    
    console.log(`   Found ${logs.length} recent logs`);
    return logs;
  } catch (err) {
    console.log(`   ⚠️ Failed to read daily logs: ${err.message}`);
    return [];
  }
}

// =============================================================================
// ACTIVITY LOG MANAGEMENT
// =============================================================================

function loadActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(ACTIVITY_LOG_PATH, 'utf8'));
    }
  } catch (err) {
    console.log(`   ⚠️ Could not load activity log: ${err.message}`);
  }
  return [];
}

function saveActivityLog(activities) {
  // Keep only the most recent items
  const trimmed = activities.slice(0, MAX_ACTIVITY_ITEMS);
  if (!DRY_RUN) {
    fs.writeFileSync(ACTIVITY_LOG_PATH, JSON.stringify(trimmed, null, 2));
  }
}

function logActivity(action, details = '', source = 'hal') {
  const activities = loadActivityLog();
  activities.unshift({
    timestamp: new Date().toISOString(),
    action,
    details,
    source
  });
  saveActivityLog(activities);
}

function extractActivitiesFromDailyLog(logPath, since) {
  // Parse the daily log to extract recent activities
  const activities = [];
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      // Look for timestamped entries like "- 10:30 AM: Did something"
      const timeMatch = line.match(/^[-*]\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?):?\s+(.+)/i);
      if (timeMatch) {
        activities.push({
          time: timeMatch[1],
          action: timeMatch[2].substring(0, 100)
        });
      }
      
      // Also look for "## Something happened" section headers as activities
      const headerMatch = line.match(/^##\s+(.+)/);
      if (headerMatch && !headerMatch[1].match(/^(Morning|Afternoon|Evening|Notes)/i)) {
        activities.push({
          time: 'log',
          action: headerMatch[1].substring(0, 100)
        });
      }
    }
  } catch (err) {
    // Silent fail
  }
  
  return activities.slice(0, 10); // Max 10 from each log
}

// =============================================================================
// STATE FILE UPDATE
// =============================================================================

function updateStateFile(cronData, tasks, agentData) {
  console.log('💾 Updating state.json...');
  
  const statePath = path.join(DASHBOARD_DIR, 'state.json');
  let state = {};
  
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (err) {
    console.log('   Creating new state.json');
  }
  
  // Update timestamp
  state.lastUpdated = new Date().toISOString();
  
  // Update health
  state.health = state.health || {};
  state.health.crons = {
    healthy: cronData.healthy,
    total: cronData.total,
    status: cronData.errors.length > 0 ? 'warning' : 'ok'
  };
  state.health.agents = { 
    active: agentData.count, 
    idle: 0, 
    status: 'ok' 
  };
  state.health.active = tasks.length;
  state.health.blocked = cronData.errors.length;
  
  // Update crons list
  state.crons = cronData.crons.map(c => ({
    name: c.name,
    schedule: c.next || c.schedule,
    health: c.status === 'error' ? 'error' : 'ok',
    lastRun: c.last,
    error: c.status === 'error' ? 'See cron logs' : null
  }));
  
  // Update active agents
  state.agents = agentData.active.map(a => ({
    key: a.key,
    name: a.agentName,
    type: a.agentType,
    age: a.age,
    tokenUsage: a.tokenUsage,
    isActive: a.isActive
  }));
  
  // Update active work from Things tasks
  state.activeWork = tasks.slice(0, 5).map((t, i) => ({
    id: t.uuid,
    title: t.title,
    status: 'waiting',
    project: t.area || t.project || 'Personal',
    progress: 50
  }));
  
  // Update stats
  state.stats = state.stats || {};
  state.stats.cronJobsTotal = cronData.total;
  
  if (!DRY_RUN) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log('   ✅ state.json updated');
  } else {
    console.log('   [DRY RUN] Would update state.json');
  }
  
  return state;
}

// =============================================================================
// HTML UPDATE
// =============================================================================

function updateDashboardHTML(state, cronData, tasks, agentData, ouraData = {}, lifeOSData = {}, taskCounts = {}, extraData = {}) {
  console.log('🎨 Updating dashboard HTML...');
  
  const htmlPath = path.join(DASHBOARD_DIR, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  
  // 1. Update timestamp
  const now = new Date();
  const timeStr = now.toLocaleDateString('en-US', { 
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles'
  });
  html = html.replace(
    /Updated: [^<]+/,
    `Updated: ${timeStr}`
  );
  
  // 2. Update System Health numbers
  html = html.replace(
    /(<div class="health-value[^"]*">)\d+\/\d+(<\/div>\s*<div class="health-label">Crons OK)/,
    `$1${cronData.healthy}/${cronData.total}$2`
  );
  
  // Update health value color based on status
  const cronHealthColor = cronData.errors.length > 0 ? 'orange' : 'green';
  html = html.replace(
    /<div class="health-value \w+">(\d+\/\d+)<\/div>\s*<div class="health-label">Crons OK/,
    `<div class="health-value ${cronHealthColor}">${cronData.healthy}/${cronData.total}</div>\n              <div class="health-label">Crons OK`
  );
  
  html = html.replace(
    /(<div class="health-value[^"]*">)\d+(<\/div>\s*<div class="health-label">Agents)/,
    `$1${agentData.count}$2`
  );
  
  html = html.replace(
    /(<div class="health-value[^"]*">)\d+(<\/div>\s*<div class="health-label">Tasks)/,
    `$1${tasks.length}$2`
  );
  
  html = html.replace(
    /(<div class="health-value[^"]*">)\d+(<\/div>\s*<div class="health-label">Blocked)/,
    `$1${cronData.errors.length}$2`
  );
  
  // Update blocked color
  const blockedColor = cronData.errors.length > 0 ? 'red' : '';
  html = html.replace(
    /<div class="health-value[^"]*">(\d+)<\/div>\s*<div class="health-label">Blocked/,
    `<div class="health-value ${blockedColor}">${cronData.errors.length}</div>\n              <div class="health-label">Blocked`
  );
  
  // 2b. Update Body Health section (Oura data)
  if (ouraData.resilience) {
    // Resilience - green for strong/adequate, orange for low, red for very low
    const resLevel = ouraData.resilience.level || 'unknown';
    const resColor = resLevel === 'strong' ? 'green' : 
                     resLevel === 'adequate' ? 'green' : 
                     resLevel === 'limited' ? 'orange' : 'red';
    html = html.replace(
      /<div class="health-value[^"]*" id="resilience-value">[^<]+<\/div>/,
      `<div class="health-value ${resColor}" id="resilience-value">${escapeHtml(resLevel)}</div>`
    );
    
    // Stress - green for restored, orange for normal, red for stressful
    const stressSummary = ouraData.stress?.summary || 'unknown';
    const stressColor = stressSummary === 'restored' ? 'green' :
                        stressSummary === 'normal' ? 'orange' :
                        stressSummary === 'stressful' ? 'red' : '';
    html = html.replace(
      /<div class="health-value[^"]*" id="stress-value">[^<]+<\/div>/,
      `<div class="health-value ${stressColor}" id="stress-value">${escapeHtml(stressSummary)}</div>`
    );
    
    // VO2 Max with trend arrow
    const vo2 = ouraData.vo2?.current || 0;
    const vo2Trend = ouraData.vo2?.trend || '';
    const trendColor = vo2Trend === '↑' ? 'var(--accent-green)' : 
                       vo2Trend === '↓' ? 'var(--accent-orange)' : 'var(--text-muted)';
    const vo2Display = vo2 > 0 ? `${vo2} <span style="font-size: 14px; color: ${trendColor};">${vo2Trend}</span>` : 'N/A';
    html = html.replace(
      /<div class="health-value[^"]*" id="vo2-value">[\s\S]*?<\/div>(\s*<div class="health-label">VO2 Max)/,
      `<div class="health-value" id="vo2-value">${vo2Display}</div>$1`
    );
  }
  
  // 3. Update Needs Jordan badge count
  const needsCount = state.needsJordan?.length || 3;
  html = html.replace(
    /(<div class="card-title">🔴 NEEDS YOU<\/div>\s*<span class="badge">)\d+(<\/span>)/,
    `$1${needsCount}$2`
  );
  
  // 4. Update cron badge
  html = html.replace(
    /(<div class="card-title">🔄 Cron Jobs<\/div>\s*<span class="badge[^"]*">)\d+\/\d+(<\/span>)/,
    `$1${cronData.healthy}/${cronData.total}$2`
  );
  
  // 5. Rebuild cron grid
  const cronGridHtml = buildCronGrid(cronData.crons);
  html = html.replace(
    /<div class="cron-grid">[\s\S]*?<\/div>(\s*<\/div>\s*<\/div>\s*<\/div>\s*<!-- LIFE OS VIEW -->)/,
    `<div class="cron-grid">\n${cronGridHtml}          </div>$1`
  );
  
  // 6. Rebuild active work section
  const activeWorkHtml = buildActiveWork(tasks);
  html = html.replace(
    /(<div class="card-header">\s*<div class="card-title">🏃 Active Work<\/div>\s*<\/div>)[\s\S]*?(<\/div>\s*<div class="card">\s*<div class="card-header">\s*<div class="card-title">⏰ Coming Up)/,
    `$1\n${activeWorkHtml}        $2`
  );
  
  // 7. Rebuild Agent Status Panel and Activity Log sections
  const newSections = buildAgentSection(agentData) + '\n\n' + buildActivitySection();
  
  if (html.includes('🤖 Active Agents')) {
    // Remove existing sections and rebuild
    html = html.replace(
      /\s*<div class="card">\s*<div class="card-header">\s*<div class="card-title">🤖 Active Agents[\s\S]*?<\/div>\s*<\/div>\s*<div class="card">\s*<div class="card-header">\s*<div class="card-title">📜 Activity Log[\s\S]*?<\/div>\s*<\/div>\s*(<div class="card" style="grid-column: 1 \/ -1;">\s*<div class="card-header">\s*<div class="card-title">🔄 Cron Jobs)/,
      `\n\n${newSections}\n        $1`
    );
  } else {
    // Insert new sections before the Cron Jobs card
    html = html.replace(
      /(<div class="card" style="grid-column: 1 \/ -1;">\s*<div class="card-header">\s*<div class="card-title">🔄 Cron Jobs)/,
      `${newSections}\n        $1`
    );
  }
  
  // 7b. Update "Needs You" section with real data
  if (extraData.needsYouItems) {
    console.log('   Updating Needs You section...');
    const needsYouHtml = buildNeedsYouSection(extraData.needsYouItems, state);
    html = html.replace(
      /<div class="card needs-jordan">[\s\S]*?<\/div>\s*<\/div>\s*(<div class="card" id="approval-queue")/,
      `${needsYouHtml}\n        \n        $1`
    );
  }
  
  // 7c. Add Quick Actions panel (after approval queue)
  console.log('   Adding Quick Actions panel...');
  const quickActionsHtml = buildQuickActionsSection();
  if (!html.includes('id="quick-actions"')) {
    html = html.replace(
      /(<\/div>\s*<\/div>\s*)(<div class="card">\s*<div class="card-header">\s*<div class="card-title">📊 System Health)/,
      `$1\n${quickActionsHtml}\n        \n        $2`
    );
  }
  
  // 7d. Add/Update System Status panel
  if (extraData.systemStatus) {
    console.log('   Updating System Status panel...');
    const systemStatusHtml = buildSystemStatusSection(extraData.systemStatus);
    if (html.includes('id="system-status"')) {
      html = html.replace(
        /<div class="card" id="system-status">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
        systemStatusHtml
      );
    } else {
      // Insert after Body card
      html = html.replace(
        /(<\/div>\s*<\/div>\s*)(<div class="card">\s*<div class="card-header">\s*<div class="card-title">🏃 Active Work)/,
        `$1\n${systemStatusHtml}\n        \n        $2`
      );
    }
  }
  
  // 7e. Use detailed cron grid with colors
  const detailedCronHtml = buildDetailedCronGrid(cronData.crons);
  html = html.replace(
    /<div class="cron-grid">[\s\S]*?<\/div>(\s*<\/div>\s*<\/div>\s*<\/div>\s*<!-- LIFE OS VIEW -->)/,
    `<div class="cron-grid">\n${detailedCronHtml}          </div>$1`
  );
  
  // 8. Update Life OS tab with real data
  if (lifeOSData && lifeOSData.goals) {
    console.log('   Updating Life OS goal progress...');
    
    // Update Income progress
    const incomeProgress = lifeOSData.goals.income?.progress || 0;
    html = html.replace(
      /(<div class="goal-progress-fill income" style="width: )\d+(%"><\/div>)/,
      `$1${incomeProgress}$2`
    );
    html = html.replace(
      /(<span class="goal-progress-value">)\d+(%<\/span>[\s\S]*?<div class="goal-progress-fill income")/,
      `$1${incomeProgress}$2`
    );
    
    // Update Body progress
    const bodyProgress = lifeOSData.goals.body?.progress || 0;
    html = html.replace(
      /(<div class="goal-progress-fill body" style="width: )\d+(%"><\/div>)/,
      `$1${bodyProgress}$2`
    );
    html = html.replace(
      /(<span class="goal-progress-value">)\d+(%<\/span>[\s\S]*?<div class="goal-progress-fill body")/,
      `$1${bodyProgress}$2`
    );
    
    // Update Relationship progress
    const relationshipProgress = lifeOSData.goals.relationship?.progress || 0;
    html = html.replace(
      /(<div class="goal-progress-fill love" style="width: )\d+(%"><\/div>)/,
      `$1${relationshipProgress}$2`
    );
    html = html.replace(
      /(<span class="goal-progress-value">)\d+(%<\/span>[\s\S]*?<div class="goal-progress-fill love")/,
      `$1${relationshipProgress}$2`
    );
    
    // Update Freedom progress
    const freedomProgress = lifeOSData.goals.freedom?.progress || 0;
    html = html.replace(
      /(<div class="goal-progress-fill freedom" style="width: )\d+(%"><\/div>)/,
      `$1${freedomProgress}$2`
    );
    html = html.replace(
      /(<span class="goal-progress-value">)\d+(%<\/span>[\s\S]*?<div class="goal-progress-fill freedom")/,
      `$1${freedomProgress}$2`
    );
    
    // Update Life Quality progress
    const joyProgress = lifeOSData.goals.lifeQuality?.progress || 60;
    html = html.replace(
      /(<div class="goal-progress-fill joy" style="width: )\d+(%"><\/div>)/,
      `$1${joyProgress}$2`
    );
    html = html.replace(
      /(<span class="goal-progress-value">)\d+(%<\/span>[\s\S]*?<div class="goal-progress-fill joy")/,
      `$1${joyProgress}$2`
    );
  }
  
  // 9. Insert/Update Q1 Rocks section in Life OS tab
  if (lifeOSData.rocks && lifeOSData.rocks.length > 0) {
    console.log('   Updating Q1 Rocks section...');
    const rocksHtml = buildRocksSection(lifeOSData);
    
    // Check if rocks section exists, if not insert it after goals-grid
    if (html.includes('id="q1-rocks"')) {
      // Replace existing rocks section
      html = html.replace(
        /<div class="card" id="q1-rocks"[\s\S]*?<\/div>\s*<\/div>\s*(<\/div>\s*<\/div>\s*<!-- LIFE OS VIEW -->|<div class="card" id="weekly-scorecard")/,
        `${rocksHtml}\n        $1`
      );
    } else {
      // Insert after goals-grid closing div
      html = html.replace(
        /(<\/div>\s*<!-- goals-grid end -->|<\/div>\s*<\/div>\s*<\/div>\s*<!-- LIFE OS VIEW -->)/,
        `</div>\n\n${rocksHtml}\n      $1`
      );
    }
  }
  
  // 10. Insert/Update Weekly Scorecard section
  if (lifeOSData.scorecard && lifeOSData.scorecard.length > 0) {
    console.log('   Updating Weekly Scorecard section...');
    const scorecardHtml = buildScorecardSection(lifeOSData);
    
    if (html.includes('id="weekly-scorecard"')) {
      html = html.replace(
        /<div class="card" id="weekly-scorecard"[\s\S]*?<\/div>\s*<\/div>\s*(<\/div>\s*<\/div>\s*<!-- LIFE OS VIEW end -->|<footer)/,
        `${scorecardHtml}\n        $1`
      );
    }
  }
  
  if (!DRY_RUN) {
    fs.writeFileSync(htmlPath, html);
    console.log('   ✅ index.html updated');
  } else {
    console.log('   [DRY RUN] Would update index.html');
  }
}

function buildRocksSection(lifeOSData) {
  const { rocks, rocksCompleted, rocksTotal, daysUntilQ1End } = lifeOSData;
  const progressPercent = rocksTotal > 0 ? Math.round((rocksCompleted / rocksTotal) * 100) : 0;
  const urgencyClass = daysUntilQ1End <= 30 ? 'urgent' : daysUntilQ1End <= 45 ? 'soon' : '';
  
  const rocksHtml = rocks.map(r => {
    const checkClass = r.done ? 'done' : '';
    const nameClass = r.done ? 'done' : '';
    return `            <div class="milestone-item">
              <div class="milestone-check ${checkClass}"></div>
              <div class="milestone-info">
                <div class="milestone-name ${nameClass}">${escapeHtml(r.description)}</div>
              </div>
            </div>`;
  }).join('\n');
  
  return `        <div class="card" id="q1-rocks" style="grid-column: 1 / -1; background: linear-gradient(135deg, #0a1a1a 0%, var(--bg-secondary) 100%); border-color: var(--accent-purple); border-width: 2px;">
          <div class="card-header">
            <div class="card-title" style="color: var(--accent-purple);">🎯 Q1 2026 Rocks</div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <span class="badge ${urgencyClass === 'urgent' ? '' : urgencyClass === 'soon' ? 'orange' : 'blue'}">${daysUntilQ1End}d left</span>
              <span class="badge ${rocksCompleted > 0 ? 'green' : ''}">${rocksCompleted}/${rocksTotal}</span>
            </div>
          </div>
          <div class="goal-progress-container" style="margin-bottom: 16px;">
            <div class="goal-progress-header">
              <span class="goal-progress-label">Overall Q1 Progress</span>
              <span class="goal-progress-value">${progressPercent}%</span>
            </div>
            <div class="goal-progress-bar">
              <div class="goal-progress-fill" style="width: ${progressPercent}%; background: linear-gradient(90deg, var(--accent-purple), var(--accent-blue));"></div>
            </div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
${rocksHtml}
          </div>
        </div>`;
}

function buildScorecardSection(lifeOSData) {
  const { scorecard } = lifeOSData;
  
  const metricsHtml = scorecard.map(m => {
    const actual = m.actual || '—';
    const hasValue = m.actual && m.actual !== '—' && m.actual.trim() !== '';
    const statusColor = hasValue ? 'var(--accent-green)' : 'var(--text-muted)';
    
    return `            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border);">
              <span style="font-size: 14px;">${escapeHtml(m.metric)}</span>
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 12px; color: var(--text-muted);">Target: ${escapeHtml(m.target)}</span>
                <span style="font-size: 16px; font-weight: 600; color: ${statusColor};">${escapeHtml(actual)}</span>
              </div>
            </div>`;
  }).join('\n');
  
  return `        <div class="card" id="weekly-scorecard" style="grid-column: 1 / -1;">
          <div class="card-header">
            <div class="card-title">📊 Weekly Scorecard</div>
            <span class="badge blue">This Week</span>
          </div>
          <div>
${metricsHtml}
          </div>
        </div>`;
}

function buildAgentSection(agentData) {
  return `        <div class="card">
          <div class="card-header">
            <div class="card-title">🤖 Active Agents</div>
            <span class="badge green">${agentData.count}</span>
          </div>
${buildAgentContent(agentData)}        </div>`;
}

function buildAgentContent(agentData) {
  if (agentData.active.length === 0) {
    return `          <div style="padding: 12px 0; color: var(--text-muted);">No active agents</div>\n`;
  }
  
  return agentData.active.slice(0, 5).map(a => {
    const statusClass = a.isActive ? 'running' : 'waiting';
    const tokenInfo = a.tokenUsage ? ` (${a.tokenUsage.percent}% ctx)` : '';
    const typeIcon = {
      'main': '🎯',
      'subagent': '🔧',
      'cron': '⏰',
      'slack': '💬'
    }[a.agentType] || '🤖';
    
    return `          <div class="work-item">
            <div class="work-status ${statusClass}"></div>
            <div class="work-info">
              <div class="work-title">${typeIcon} ${escapeHtml(a.agentName)}${escapeHtml(tokenInfo)}</div>
              <div class="work-project">${escapeHtml(a.age)}</div>
            </div>
          </div>`;
  }).join('\n');
}

function buildActivitySection() {
  return `        <div class="card">
          <div class="card-header">
            <div class="card-title">📜 Activity Log</div>
          </div>
${buildActivityContent()}        </div>`;
}

function buildActivityContent() {
  const activities = loadActivityLog().slice(0, 8);
  
  if (activities.length === 0) {
    return `          <div style="padding: 12px 0; color: var(--text-muted);">No recent activity</div>\n`;
  }
  
  return activities.map(a => {
    const time = new Date(a.timestamp);
    const timeStr = time.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles'
    });
    
    return `          <div class="work-item">
            <div class="work-status" style="background: var(--accent-blue);"></div>
            <div class="work-info">
              <div class="work-title">${escapeHtml(a.action)}</div>
              <div class="work-project">${escapeHtml(timeStr)}${a.details ? ' — ' + escapeHtml(a.details.substring(0, 50)) : ''}</div>
            </div>
          </div>`;
  }).join('\n');
}

function buildCronGrid(crons) {
  // Show top 9 crons for the grid
  const topCrons = crons.slice(0, 9);
  return topCrons.map(c => {
    const healthClass = c.status === 'error' ? 'error' : 'ok';
    const schedule = formatSchedule(c.next || c.schedule);
    return `            <div class="cron-item"><div class="cron-health ${healthClass}"></div><span class="cron-name">${escapeHtml(c.name)}</span><span class="cron-schedule">${escapeHtml(schedule)}</span></div>`;
  }).join('\n');
}

function buildActiveWork(tasks) {
  if (tasks.length === 0) {
    return `          <div style="padding: 12px 0; color: var(--text-muted);">No active tasks today</div>\n`;
  }
  
  return tasks.slice(0, 4).map(t => {
    return `          <div class="work-item">
            <div class="work-status waiting"></div>
            <div class="work-info">
              <div class="work-title">${escapeHtml(t.title)}</div>
              <div class="work-project">${escapeHtml(t.area || t.project || 'Personal')}</div>
            </div>
            <div class="work-progress"><div class="work-progress-bar" style="width: 50%"></div></div>
          </div>`;
  }).join('\n');
}

function formatSchedule(schedule) {
  if (!schedule) return '-';
  // Extract just the time part if it's a "in Xh" format
  if (schedule.startsWith('in ')) {
    return schedule;
  }
  // Extract time from cron expression
  const match = schedule.match(/(\d+)\s+(\d+)/);
  if (match) {
    const [, min, hour] = match;
    const h = parseInt(hour);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return `${h12}${ampm}`;
  }
  return schedule.substring(0, 8);
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildQuickActionsSection() {
  return `        <div class="card" id="quick-actions" style="grid-column: 1 / -1;">
          <div class="card-header">
            <div class="card-title">⚡ Quick Actions</div>
          </div>
          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            <button class="btn btn-approve" onclick="triggerAction('refresh')" style="min-width: 140px;">
              🔄 Refresh Dashboard
            </button>
            <button class="btn btn-approve" onclick="triggerAction('sessions')" style="min-width: 140px;">
              🤖 Check Sessions
            </button>
            <button class="btn btn-approve" onclick="triggerAction('things')" style="min-width: 140px;">
              📋 Sync Things
            </button>
            <button class="btn btn-approve" onclick="triggerAction('crons')" style="min-width: 140px;">
              ⏰ View Cron Logs
            </button>
          </div>
        </div>`;
}

function buildSystemStatusSection(systemStatus) {
  const contextPercent = systemStatus.mainSessionContext?.percent || 0;
  const contextColor = contextPercent > 80 ? 'red' : contextPercent > 60 ? 'orange' : 'green';
  
  return `        <div class="card" id="system-status">
          <div class="card-header">
            <div class="card-title">🖥️ System Status</div>
          </div>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
            <div class="health-item">
              <div class="health-value" style="font-size: 16px;">v${escapeHtml(systemStatus.clawdbotVersion)}</div>
              <div class="health-label">Clawdbot</div>
            </div>
            <div class="health-item">
              <div class="health-value ${contextColor}" style="font-size: 20px;">${contextPercent}%</div>
              <div class="health-label">Main Context</div>
            </div>
            <div class="health-item">
              <div class="health-value" style="font-size: 18px;">${systemStatus.memoryFileSize}KB</div>
              <div class="health-label">Memory Files</div>
            </div>
            <div class="health-item">
              <div class="health-value" style="font-size: 18px;">${systemStatus.notesFileCount}</div>
              <div class="health-label">Notes Files</div>
            </div>
          </div>
        </div>`;
}

function buildNeedsYouSection(needsYouItems, state) {
  // Combine new items with existing state items
  const existingItems = state.needsJordan || [];
  
  // Prioritize: existing high-priority items first, then new items
  const allItems = [
    ...existingItems.slice(0, 2),
    ...needsYouItems.slice(0, 3)
  ].slice(0, 5);
  
  const itemCount = allItems.length;
  
  const itemsHtml = allItems.map(item => {
    const priorityClass = item.priority === 'P1' ? 'var(--accent-red)' : 'var(--accent-orange)';
    const typeIcon = item.type === 'awaiting' ? '📨' : item.type === 'task' ? '✅' : '📋';
    
    return `          <div class="need-item" style="border-left-color: ${priorityClass};">
            <h4>${escapeHtml(item.title)}</h4>
            <p>${escapeHtml(item.context || item.description || '')}</p>
            <div class="need-meta">
              <span>${typeIcon} ${escapeHtml(item.source || item.project || item.type)}</span>
              <span>⚡ ${escapeHtml(item.priority || 'P2')}</span>
            </div>
          </div>`;
  }).join('\n');
  
  return `        <div class="card needs-jordan">
          <div class="card-header">
            <div class="card-title">🔴 NEEDS YOU</div>
            <span class="badge">${itemCount}</span>
          </div>
${itemsHtml}
        </div>`;
}

function buildDetailedCronGrid(crons) {
  // Show all crons with detailed status
  return crons.slice(0, 12).map(c => {
    // Color based on status
    let healthClass = 'ok';
    let tooltipText = `Last: ${c.last || 'never'}`;
    
    if (c.status === 'error') {
      healthClass = 'error';
      tooltipText = 'ERROR - Check logs';
    } else if (c.last === '-' || c.last === 'never') {
      healthClass = 'warning';
      tooltipText = 'Never run';
    }
    
    const schedule = formatSchedule(c.next || c.schedule);
    const lastRun = c.last && c.last !== '-' ? ` (${c.last})` : '';
    
    return `            <div class="cron-item" title="${escapeHtml(tooltipText)}" style="${healthClass === 'warning' ? 'opacity: 0.7;' : ''}">
              <div class="cron-health ${healthClass === 'warning' ? 'ok' : healthClass}" style="${healthClass === 'warning' ? 'background: var(--accent-orange);' : ''}"></div>
              <span class="cron-name">${escapeHtml(c.name)}</span>
              <span class="cron-schedule">${escapeHtml(schedule)}${escapeHtml(lastRun)}</span>
            </div>`;
  }).join('\n');
}

// =============================================================================
// MAIN
// =============================================================================

function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('Dashboard Auto-Updater');
  console.log('='.repeat(60));
  console.log('');
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE - No files will be modified\n');
  }
  
  // Collect data
  const cronData = getCronDetailedStatus();
  const tasks = getThingsTasks();
  const agentData = getActiveAgents();
  const logs = getRecentDailyLogs();
  const ouraData = getOuraBodyStats();
  const lifeOSData = getLifeOSData();
  const taskCounts = getThingsTaskCounts();
  
  // New data sources
  const awaitingResponses = getAwaitingResponses();
  const approvalItems = getApprovalQueueItems();
  const priorityTasks = getHighPriorityTasks();
  const systemStatus = getSystemStatus();
  
  // Combine "Needs You" items
  const needsYouItems = [
    ...awaitingResponses.map(a => ({
      type: 'awaiting',
      title: a.title,
      context: a.status || `Check: ${a.channel}`,
      priority: 'P2',
      source: a.channel,
      link: a.whereToCheck
    })),
    ...priorityTasks.map(t => ({
      type: 'task',
      title: t.title,
      context: t.project ? `Project: ${t.project}` : 'Today task',
      priority: 'P1',
      source: 'Things'
    }))
  ];
  
  console.log('');
  
  // Log this update as an activity
  if (!DRY_RUN) {
    logActivity('Dashboard updated', `${cronData.healthy}/${cronData.total} crons OK, ${tasks.length} tasks, ${agentData.count} agents`, 'system');
  }
  
  // Update files
  const state = updateStateFile(cronData, tasks, agentData);
  
  // Pass all new data to HTML updater
  const extraData = {
    needsYouItems,
    systemStatus,
    awaitingResponses,
    approvalItems
  };
  updateDashboardHTML(state, cronData, tasks, agentData, ouraData, lifeOSData, taskCounts, extraData);
  
  // Save all data to state.json for dashboard server
  if (!DRY_RUN) {
    const statePath = path.join(DASHBOARD_DIR, 'state.json');
    try {
      const existingState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      existingState.lifeOS = lifeOSData;
      existingState.taskCounts = taskCounts;
      existingState.systemStatus = systemStatus;
      existingState.needsYouItems = needsYouItems;
      existingState.awaitingResponses = awaitingResponses;
      fs.writeFileSync(statePath, JSON.stringify(existingState, null, 2));
    } catch (err) {
      console.log(`   ⚠️ Could not update state.json with extra data: ${err.message}`);
    }
  }
  
  console.log('');
  console.log('📊 Summary:');
  console.log(`   - Crons: ${cronData.healthy}/${cronData.total} healthy`);
  console.log(`   - Tasks: ${tasks.length} active (Today: ${taskCounts.today}, Inbox: ${taskCounts.inbox})`);
  console.log(`   - Agents: ${agentData.count} running`);
  console.log(`   - Q1 Rocks: ${lifeOSData.rocksCompleted}/${lifeOSData.rocksTotal} done (${lifeOSData.daysUntilQ1End}d left)`);
  console.log(`   - Needs You: ${needsYouItems.length} items`);
  console.log(`   - System: Clawdbot v${systemStatus.clawdbotVersion}, ${systemStatus.mainSessionContext?.percent || '?'}% context`);
  console.log(`   - Errors: ${cronData.errors.length}`);
  if (cronData.errors.length > 0) {
    console.log(`   - Failed crons: ${cronData.errors.map(e => e.name).join(', ')}`);
  }
}

main();
