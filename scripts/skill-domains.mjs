import { foldVietnamese, translateVietnamese } from './skill-terms.mjs'

const HIT1_DELTA = 0.02
const PASS_DELTA = 0

export const DOMAINS = Object.freeze([
  'data', 'engineering', 'viz', 'marketing', 'growth', 'research', 'product', 'finance', 'accounting',
  'personal', 'operations', 'crm', 'people', 'legal', 'design', 'education', 'logistics',
  'localization', 'workflow',
])

const GLOSSARY_ENGLISH = Object.freeze({
  data: ['analysis', 'data', 'statistics', 'segmentation', 'cohort analysis', 'retention', 'churn', 'conversion', 'funnel', 'forecast', 'experiment', 'a/b test', 'predictive model', 'prediction', 'correlation', 'exploratory data analysis', 'data cleaning', 'data quality', 'dataset', 'metrics'],
  engineering: ['programming', 'software engineering', 'source code', 'database', 'migration', 'authentication', 'authorization', 'performance', 'automated testing', 'security', 'vulnerability', 'integration', 'deployment', 'architecture'],
  viz: ['chart', 'dashboard', 'presentation', 'spreadsheet', 'visualization', 'executive summary'],
  marketing: ['campaign', 'positioning', 'messaging', 'copywriting', 'writing', 'seo', 'landing page', 'social media', 'brand voice', 'content calendar', 'launch', 'advertising', 'brand'],
  growth: ['roas', 'cpi', 'cac', 'ltv', 'payback', 'growth', 'bidding', 'media plan', 'attribution', 'aso', 'performance marketing'],
  research: ['market research', 'market sizing', 'competitor', 'benchmark', 'survey', 'survey design', 'cross-tab', 'persona', 'interview', 'scenario', 'hypothesis', 'ux research'],
  product: ['prd', 'roadmap', 'backlog', 'prioritization', 'kpi', 'okr', 'pricing', 'unit economics', 'planning', 'project', 'project management', 'schedule', 'progress', 'staffing', 'employee', 'internal communication', 'announcement', 'policy', 'comparison', 'checklist', 'critical path', 'capacity plan', 'scorecard', 'document'],
  finance: ['business case', 'budget', 'budget allocation', 'scenario', 'portfolio', 'margin', 'sensitivity', 'working capital', 'cash flow', 'revenue', 'cost', 'profit', 'break-even', 'burn rate', 'runway'],
  accounting: ['accounting', 'bookkeeping', 'journal entry', 'reconciliation', 'chart of accounts', 'accrual', 'month-end close', 'p&l', 'balance sheet', 'vat', 'invoice', 'trial balance', 'audit', 'materiality', 'sampling', 'internal controls', 'workpapers'],
  personal: ['personal finance', 'household budget', 'emergency fund', 'debt payoff', 'savings', 'compound interest', 'retirement', 'net worth', 'insurance', 'loan', 'interest rate'],
  operations: ['small business', 'supplier', 'inventory', 'procurement', 'production', 'capacity', 'production scheduling', 'sop', 'standard operating procedure', 'quality', 'preventive maintenance', 'root cause', 'nonconformance', 'retail', 'payment terms', 'sales', 'credit terms', 'promotion', 'product listing', 'product page', 'search ranking', 'keyword', 'shopping cart', 'abandoned cart', 'cycle count', 'cash drawer', 'cashier', 'distributor', 'memory leak'],
  crm: ['sales pipeline', 'customer', 'lead', 'lead qualification', 'quota', 'sales forecast', 'win loss', 'crm', 'ticket', 'ticket triage', 'sla', 'csat', 'nps', 'knowledge base', 'complaint', 'escalation'],
  people: ['recruiting', 'hiring', 'job description', 'structured interview', 'onboarding', 'compensation', 'performance review', 'engagement survey', 'attrition', 'hr', 'headcount', 'candidate', 'hiring pipeline', 'offer', 'turnover', 'salary', 'pay band'],
  legal: ['legal', 'contract', 'contract review', 'information security', 'nda', 'clause', 'termination', 'liability', 'indemnification', 'redline', 'compliance', 'data privacy', 'customs', 'renewal', 'fraud', 'segregation of duties', 'software license', 'data breach'],
  design: ['ui', 'ux', 'usability testing', 'user flow', 'wireframe', 'information architecture', 'accessibility', 'motion', 'design system', 'typography', 'spacing', 'persona', 'heuristic evaluation', 'prototype'],
  education: ['learning objectives', 'curriculum', 'syllabus', 'lesson plan', 'assessment', 'e-learning', 'workshop', 'skill gap', 'training', 'survey', 'course outline', 'quiz', 'video script'],
  logistics: ['freight', 'carrier', 'hs code', 'incoterms', 'shipment exception', 'returns', 'reverse logistics', 'demand planning', 'safety stock', 'warehouse'],
  localization: ['translation', 'tone preservation', 'market adaptation', 'vi-vn', 'localization'],
})

const DOMAIN_SYNONYMS = Object.freeze({
  data: ['analytics', 'etl', 'pipeline', 'query', 'causal'], engineering: ['api', 'software', 'coding', 'javascript', 'typescript', 'python', 'backend', 'frontend', 'container', 'kubernetes', 'redis', 'postgres', 'c++', 'c#', 'ruby', 'rust', 'swift', 'java', 'kotlin', 'target project', 'github actions', 'self-testing', 'php'], viz: ['plot', 'diagram', 'graph'],
  marketing: ['creative', 'seo audit'], growth: ['acquisition', 'cpi'], research: ['evidence', 'literature'],
  product: ['requirements', 'feature', 'stakeholder'], finance: ['financial', 'budgeting'],
  accounting: ['ledger', 'tax'], personal: ['household'], operations: ['vendor'],
  crm: ['support'], people: ['human resources'], legal: ['privacy'], design: ['interface'],
  education: ['learning'], logistics: ['shipping'], localization: ['i18n', 'l10n'], workflow: [],
})

export const DOMAIN_KEYWORDS = Object.freeze(Object.fromEntries(
  DOMAINS.map((domain) => [domain, Object.freeze([
    ...new Set([...(GLOSSARY_ENGLISH[domain] ?? []), ...(DOMAIN_SYNONYMS[domain] ?? [])]),
  ])]),
))

const tag = (domain, ...names) => names.map((name) => [name, [domain]])
const SKILL_GROUPS = [
  ...tag('accounting', 'accounting-bookkeeping', 'finance-billing-ops', 'customer-billing-ops'),
  ...tag('marketing', 'aso', 'brand-discovery', 'brand-voice', 'creative-brief', 'marketing-campaign', 'content-engine', 'influencer-strategy', 'social-publisher', 'crisis-communication', 'crosspost', 'email-ops'),
  ...tag('growth', 'funnel-analytics', 'ltv-cohort-modeling', 'marketing-attribution', 'media-planning', 'performance-marketing', 'unit-economics', 'growth-log'),
  ...tag('data', 'causal-inference'),
  ...tag('data', 'pack-game-analytics'),
  ...tag('research', 'market-research', 'market-research-reports', 'competitive-platform-analysis', 'competitive-report-structure', 'benchmark-methodology', 'literature-review', 'peer-review', 'scholar-evaluation', 'research-grants', 'survey-design', 'interpreting-culture-index', 'lead-intelligence'),
  ...tag('product', 'product-capability', 'product-lens', 'product-manager', 'project-manager', 'okr-planning', 'intent-driven-development', 'blueprint', 'council', 'update-docs'),
  ...tag('workflow', 'interview-ask-back', 'interview-elicitation', 'agent-context-persistence', 'context-discipline', 'exec-deliverable', 'fast-path', 'executor-fallback', 'parallel-execution', 'preflight', 'profile-pilot', 'review-conformance', 'review-dual', 'review-feedback', 'review-quality', 'review-security', 'run-ledger', 'session-report', 'jev-assist', 'skill-selection', 'plan-architecture', 'plan-backlog', 'plan-research-first', 'brainstorm-argumentation', 'brainstorm-debate', 'brainstorm-lenses', 'task-loop', 'final-review'),
  ...tag('finance', 'personal-finance', 'real-estate-analysis', 'investor-materials', 'what-if-oracle', 'usfiscaldata'),
  ...tag('operations', 'ecommerce-operations', 'manufacturing-ops-planning', 'inventory-demand-planning', 'production-scheduling', 'quality-nonconformance', 'sme-operations', 'sop-authoring', 'warehouse-operations', 'returns-reverse-logistics', 'logistics-exception-management', 'energy-procurement', 'carrier-relationship-management'),
  ...tag('crm', 'sales-pipeline-crm', 'customer-support-ops'),
  ...tag('people', 'hr-recruiting', 'training-curriculum-design'),
  ...tag('legal', 'legal-contract-basics', 'hipaa-compliance', 'customs-trade-compliance', 'audit-context-building', 'audit-prep-assistant', 'financial-audit'),
  ...tag('design', 'design-fundamentals', 'design-system', 'frontend-a11y', 'frontend-design', 'frontend-design-direction', 'frontend-slides', 'liquid-glass-design', 'make-interfaces-feel-better', 'theme-factory', 'typeui-fundamentals', 'ux-research-wireframing', 'accessibility', 'remotion-video-creation'),
  ...tag('localization', 'localization', 'localization-copy', 'visa-doc-translate'),
  ...tag('data', 'data-quality', 'data-quality-checks', 'data-scraper-agent', 'data-throughput-accelerator', 'dbt-patterns', 'event-taxonomy', 'exploratory-data-analysis', 'experimental-design', 'json-data-wrangling', 'polars', 'statistical-analysis', 'statistical-power', 'statsmodels', 'scikit-learn', 'timesfm-forecasting', 'transformers', 'umap-learn', 'cohort-retention-analysis', 'warehouse-modeling', 'clickhouse-io', 'xlsx'),
  ...tag('engineering', 'api-connector-builder', 'api-design', 'backend-patterns', 'codebase-onboarding', 'database-migrations', 'deployment-patterns', 'docker-patterns', 'error-handling', 'kubernetes-patterns', 'mcp-server-patterns', 'postgres-patterns', 'python-patterns', 'redis-patterns', 'react-patterns', 'systematic-debugging', 'exec-python', 'exec-typescript', 'exec-cpp', 'exec-csharp', 'exec-go', 'exec-jvm', 'exec-php', 'exec-ruby', 'exec-rust', 'exec-self-testing', 'exec-swift', 'exec-coding-standards', 'regex-vs-llm-structured-text', 'mle-reviewer', 'mle-workflow'),
  ...tag('product', 'google-workspace-ops', 'internal-comms', 'game-director', 'game-designer-balance', 'game-designer-systems'),
  ...tag('engineering', 'exec-github-actions', 'security-review'),
  ...tag('viz', 'exec-visualization', 'dashboard-builder', 'd3-viz', 'matplotlib', 'seaborn', 'infographics', 'pptx', 'golden-pptx', 'scientific-slides'),
  ...tag('marketing', 'article-writing', 'seo', 'profile-content'),
  ...tag('product', 'docx', 'liteparse', 'doc-coauthoring', 'profile-design', 'profile-plan'),
  ...tag('research', 'citation-management'),
]

function buildSkillTags(groups) {
  const tags = {}
  for (const [name, domains] of groups) {
    if (tags[name]) throw new Error(`duplicate skill domain tag: ${name}`)
    tags[name] = Object.freeze(domains)
  }
  return Object.freeze(tags)
}

const ALL_SKILL_TAGS = buildSkillTags(SKILL_GROUPS)
export const SKILL_DOMAINS = Object.freeze(ALL_SKILL_TAGS)

export const DOMAIN_TAG_BOOST = 1
export const DOMAIN_TAGS_DEFAULT = false

function keywordPattern(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i')
}

export function requestDomains(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  const folded = foldVietnamese(text)
  const translated = translateVietnamese(folded).terms
  const haystack = `${folded} ${translated.join(' ')}`
  return DOMAINS.filter((domain) => DOMAIN_KEYWORDS[domain].some((keyword) => keywordPattern(foldVietnamese(keyword)).test(haystack)))
    .sort()
}

export function domainTagGate({ en, vi }) {
  const reasons = []
  for (const [language, result] of [['en', en], ['vi', vi]]) {
    if (result.on.hit1 < result.off.hit1 + HIT1_DELTA - Number.EPSILON) reasons.push(`${language}: Hit@1 lift < ${HIT1_DELTA}`)
    if (result.on.pass < result.off.pass + PASS_DELTA - Number.EPSILON) reasons.push(`${language}: pass rate dropped`)
  }
  return { enable: reasons.length === 0, reasons }
}
