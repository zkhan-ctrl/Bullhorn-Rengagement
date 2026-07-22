#!/usr/bin/env python3
"""
Universal job scraper for CGR Re-Engagement Tool.
Usage: python3 scrape_jobs.py "Company Name" [homepage_or_careers_url]

Pipeline per company:
  Stage 1 — Discover the careers page from the homepage
             then drill into the actual listings page if it's a landing page
  Stage 2 — Detect ATS platform and call its JSON API directly
  Stage 3 — Fallback: plain HTML parse → Playwright render → LLM extraction

Output (stdout): { "data": [...], "total": N, "method": "...", "careersUrl": "..." }
"""
import sys, json, re, os
from datetime import date, datetime
from urllib.parse import urljoin, urlparse

# ── HTTP client (httpx with retries) ──────────────────────────────────────────

try:
    import httpx
    _TRANSPORT = httpx.HTTPTransport(retries=2)

    def http_get(url, timeout=8, headers=None, follow=True):
        h = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if headers:
            h.update(headers)
        try:
            with httpx.Client(transport=_TRANSPORT, follow_redirects=follow,
                              timeout=timeout) as c:
                r = c.get(url, headers=h)
                return r.text, str(r.url)
        except Exception:
            return None, None

    def http_post_json(url, payload, timeout=8, headers=None):
        h = {'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json',
             'Accept': 'application/json'}
        if headers:
            h.update(headers)
        try:
            with httpx.Client(transport=_TRANSPORT, follow_redirects=True,
                              timeout=timeout) as c:
                r = c.post(url, json=payload, headers=h)
                return r.json()
        except Exception:
            return None

    def http_get_json(url, timeout=8, headers=None):
        h = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
        if headers:
            h.update(headers)
        try:
            with httpx.Client(transport=_TRANSPORT, follow_redirects=True,
                              timeout=timeout) as c:
                r = c.get(url, headers=h)
                return r.json()
        except Exception:
            return None

except ImportError:
    from urllib.request import urlopen, Request

    def http_get(url, timeout=8, headers=None, follow=True):
        h = {'User-Agent': 'Mozilla/5.0 (compatible)', 'Accept': '*/*'}
        if headers:
            h.update(headers)
        try:
            req = Request(url, headers=h)
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', errors='replace'), resp.url
        except Exception:
            return None, None

    def http_post_json(url, payload, timeout=8, headers=None):
        import urllib.request
        data = json.dumps(payload).encode()
        h = {'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json',
             'Accept': 'application/json'}
        if headers:
            h.update(headers)
        try:
            req = urllib.request.Request(url, data=data, headers=h, method='POST')
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            return None

    def http_get_json(url, timeout=8, headers=None):
        html, _ = http_get(url, timeout=timeout,
                           headers={'Accept': 'application/json', **(headers or {})})
        if html:
            try:
                return json.loads(html)
            except Exception:
                pass
        return None

# ── HTML helpers ──────────────────────────────────────────────────────────────

try:
    from bs4 import BeautifulSoup
    def parse_html(html):
        return BeautifulSoup(html, 'html.parser')
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False
    def parse_html(html):
        return None

# ── Shared utilities ──────────────────────────────────────────────────────────

CAREER_KEYWORDS = re.compile(
    r'\b(careers?|jobs?|employment|join|join.us|work.with.us|work.for.us|'
    r'opportunities|now.hiring|apply|vacancies|openings|positions|hiring)\b',
    re.I
)

CAREER_PATHS = [
    '/careers', '/jobs', '/employment', '/join-us', '/work-with-us',
    '/opportunities', '/openings', '/about/careers', '/company/careers',
    '/careers/open-positions', '/careers/', '/join/', '/positions',
    # Extended paths seen in the wild
    '/career', '/available-opportunities', '/current-opportunities',
    '/job-listings', '/job-openings', '/careers/jobs', '/en/careers',
    '/about/jobs', '/work-here', '/now-hiring', '/talent',
    '/jobs/search', '/open-positions', '/job-opportunities',
]

# URL path segments that indicate a page is NOT a careers page (services, products, etc.)
NON_CAREERS_PATH_RE = re.compile(
    r'/(?:service|product|solution|case.stud|about|team|contact|'
    r'news|blog|press|media|investor|partner|resource|privacy|'
    r'terms|legal|support|faq)s?(?:/|$)',
    re.I
)

# Links that mean "view the actual job listings" (from a landing/culture page)
VIEW_JOBS_RE = re.compile(
    r'\b(view|see|browse|find|explore|search|check\s+out)\s+(jobs?|positions?|openings?|opportunit\w*|roles?|vacancies|listings?)\b'
    r'|\b(current|open|available|active|all)\s+(positions?|openings?|jobs?|roles?|listings?|postings?)\b'
    r'|\bjob\s+(listings?|boards?|search|portal|postings?|openings?|opportunit\w*)\b'
    r'|\bjobs?\s+(in|for|at|available|near)\b'
    r'|\bopen\s+roles?\b'
    r'|\bcareer\s+(opportunities?|openings?|listings?|postings?)\b'
    r'|\bwork\s+(with|for)\s+us\b'
    r'|\bjoin\s+(our\s+)?(team|us|company)\b'
    r'|\bapply\s+(now|today|here)\b'
    r'|\bpositions?\s+(available|open|listed)\b',
    re.I
)

# href patterns that indicate a page contains individual job listings
JOB_LISTING_HREF_RE = re.compile(
    r'/(jobs?|careers?/jobs?|positions?|openings?|apply|posting|requisition|vacancies)'
    r'|[?&](jobId|req_id|category|job_id|positionId)=',
    re.I
)

def base_url(url):
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"

def make_job(title, company='', location='', dept='', job_type='',
             url='', date_posted=None, salary='', remote_type='Unknown', source=''):
    return {
        'title':      title.strip(),
        'company':    company.strip(),
        'location':   location.strip(),
        'department': dept.strip(),
        'type':       job_type or 'Full-time',
        'url':        url,
        'source':     source,
        'datePosted': date_posted,
        'daysPosted': days_since(date_posted),
        'salary':     salary,
        'remoteType': remote_type,
        'isRemote':   remote_type == 'Remote',
    }

def days_since(d):
    if not d:
        return None
    try:
        return max(0, (date.today() - datetime.strptime(str(d)[:10], '%Y-%m-%d').date()).days)
    except Exception:
        return None

def norm_remote(text):
    t = (text or '').lower()
    if 'remote' in t and 'hybrid' in t:
        return 'Hybrid'
    if 'remote' in t:
        return 'Remote'
    if 'hybrid' in t:
        return 'Hybrid'
    if any(x in t for x in ('on-site', 'onsite', 'on site', 'in-office', 'in office')):
        return 'On-site'
    return 'Unknown'

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 1a — Careers page discovery
# ─────────────────────────────────────────────────────────────────────────────

def find_careers_url(start_url):
    """Given a homepage, find the best careers/jobs page."""
    if not start_url:
        return None, None

    if '://' not in start_url:
        start_url = 'https://' + start_url

    # If the URL itself IS an ATS portal (e.g. Bullhorn stores the ADP URL directly),
    # return it immediately so detect_ats in scrape_company picks it up.
    quick_ats, _ = detect_ats(start_url, '')
    if quick_ats:
        html, final = http_get(start_url)
        return (final or start_url), html

    # If the URL already looks like a careers page, use it directly
    if CAREER_KEYWORDS.search(urlparse(start_url).path):
        html, final = http_get(start_url)
        return (final or start_url), html

    html, final_url = http_get(start_url)
    if not html:
        return None, None

    origin = base_url(final_url or start_url)
    candidates = []  # (score, url)

    # Scan <a> tags
    if HAS_BS4:
        soup = parse_html(html)
        for a in soup.find_all('a', href=True):
            href = a['href'].strip()
            text = a.get_text(' ', strip=True)
            full = urljoin(final_url or start_url, href)
            score = 0
            if CAREER_KEYWORDS.search(text):
                score += 3
            if CAREER_KEYWORDS.search(href):
                score += 2
            if score:
                candidates.append((score, full))
    else:
        for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([^<]{2,60})</a>',
                             html, re.I):
            href, text = m.group(1), m.group(2)
            full = urljoin(final_url or start_url, href)
            score = 0
            if CAREER_KEYWORDS.search(text):
                score += 3
            if CAREER_KEYWORDS.search(href):
                score += 2
            if score:
                candidates.append((score, full))

    # Also try common direct paths
    for path in CAREER_PATHS:
        candidates.append((1, origin + path))

    seen = set()
    for _score, url in sorted(candidates, reverse=True):
        if url in seen:
            continue
        seen.add(url)
        path = urlparse(url).path
        # Skip pages that are clearly not careers (services, products, about, etc.)
        if NON_CAREERS_PATH_RE.search(path) and not CAREER_KEYWORDS.search(path):
            continue
        page_html, page_final = http_get(url, timeout=8)
        if not page_html or len(page_html) < 500:
            continue
        # Also skip if after redirects we ended up on a clearly non-careers page
        final_path = urlparse(page_final or url).path
        if NON_CAREERS_PATH_RE.search(final_path) and not CAREER_KEYWORDS.search(final_path):
            continue
        # Avoid soft-404s that silently redirect to the homepage
        if final_path in ('/', ''):
            continue
        return (page_final or url), page_html

    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 1b — Drill from landing page to actual listings
# ─────────────────────────────────────────────────────────────────────────────

def drill_to_listings(careers_html, careers_url):
    """
    If the careers page is a culture/benefits landing page, follow
    'View Job Opportunities' / 'Job Postings' / 'Current Openings' type links
    to the page that actually lists individual job titles.
    Checks both link text AND href patterns; returns highest-scoring candidate.
    """
    if not careers_html or not HAS_BS4:
        return None, None
    soup = parse_html(careers_html)
    candidates = []  # (score, full_url)
    seen_urls = set()

    for a in soup.find_all('a', href=True):
        text = a.get_text(' ', strip=True)
        href = a['href'].strip()
        if not href or href.startswith('#') or 'javascript' in href.lower():
            continue
        full_url = urljoin(careers_url, href)
        parsed = urlparse(full_url)
        if full_url == careers_url or not parsed.netloc:
            continue
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)
        score = 0
        if VIEW_JOBS_RE.search(text):
            score += 3
        if JOB_LISTING_HREF_RE.search(href):
            score += 2
        if CAREER_KEYWORDS.search(href) and not CAREER_KEYWORDS.search(
                urlparse(careers_url).path):
            score += 1
        if score > 0:
            candidates.append((score, full_url))

    for _score, url in sorted(candidates, key=lambda x: x[0], reverse=True):
        page_html, final_url = http_get(url, timeout=8)
        if page_html and len(page_html) > 500:
            return (final_url or url), page_html
    return None, None


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 2 — ATS detection + native API handlers
# ─────────────────────────────────────────────────────────────────────────────

def detect_ats(url, html):
    """Return (ats_name, config_dict) or (None, None)."""
    if not url:
        return None, None

    scan_targets = [url, html or '']
    if HAS_BS4 and html:
        soup = parse_html(html)
        for tag in soup.find_all(['iframe', 'script']):
            for attr in ('src', 'data-src'):
                v = tag.get(attr, '')
                if v:
                    scan_targets.append(v)

    combined = ' '.join(scan_targets)

    # Greenhouse — boards, job-boards, embed (with ?for= query param), and boards-api
    m = (re.search(r'(?:boards|job-boards)\.greenhouse\.io/(?!embed/)([a-z0-9_-]+)', combined, re.I)
         or re.search(r'boards-api\.greenhouse\.io/v1/boards/([a-z0-9_-]+)/', combined, re.I)
         or re.search(r'embed\.greenhouse\.io/[^\s"\']*[?&]for=([a-z0-9_-]+)', combined, re.I))
    if m:
        return 'Greenhouse', {'token': m.group(1)}

    # Lever — US and EU hosting
    m = re.search(r'jobs(?:\.eu)?\.lever\.co/([a-z0-9_-]+)', combined, re.I)
    if m:
        eu = 'eu.' in (m.group(0) or '').lower()
        return 'Lever', {'company': m.group(1), 'eu': eu}

    m = re.search(r'jobs\.ashbyhq\.com/([a-z0-9_-]+)', combined, re.I)
    if m:
        return 'Ashby', {'company': m.group(1)}

    m = re.search(r'ats\.rippling\.com/([a-z0-9_-]+)/jobs', combined, re.I)
    if m:
        return 'Rippling', {'company': m.group(1)}

    m = re.search(r'apply\.workable\.com/([A-Za-z0-9_-]+)', combined, re.I)
    if m:
        return 'Workable', {'company': m.group(1)}

    m = re.search(r'careers\.smartrecruiters\.com/([A-Za-z0-9_-]+)', combined)
    if not m:
        m = re.search(r'smartrecruiters\.com/([A-Za-z0-9_-]+)', combined)
    if m:
        return 'SmartRecruiters', {'company': m.group(1)}

    m = re.search(r'([a-z0-9-]+)\.bamboohr\.com', combined, re.I)
    if m:
        return 'BambooHR', {'subdomain': m.group(1)}

    m = re.search(r'([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/([a-z0-9_-]+)/([a-z0-9_-]+)',
                  combined, re.I)
    if m:
        return 'Workday', {'tenant': m.group(1), 'wd': m.group(2), 'site': m.group(3)}
    m = re.search(r'([a-z0-9-]+)\.myworkdayjobs\.com', combined, re.I)
    if m:
        return 'Workday', {'tenant': m.group(1), 'wd': None, 'site': None}

    m = re.search(r'fa-([a-z0-9-]+)\.fa\.em\d+\.oraclecloud\.com', combined, re.I)
    if not m:
        m = re.search(r'([\w-]+\.fa\.[\w.]+\.oraclecloud\.com)', combined, re.I)
    if m:
        sn = re.search(r'siteNumber=([A-Z0-9]+)', combined)
        return 'Oracle', {'host': m.group(1), 'siteNumber': sn.group(1) if sn else None}

    if 'icims.com' in combined:
        m = re.search(r'([\w-]+\.icims\.com)', combined, re.I)
        return 'iCIMS', {'host': m.group(1) if m else None}

    m = re.search(r'([a-z0-9-]+)\.applytojob\.com', combined, re.I)
    if m:
        return 'JazzHR', {'subdomain': m.group(1)}

    m = re.search(r'recruiting\.paylocity\.com/recruiting/jobs/All/(\d+)/([^/\s"\']+)', combined)
    if m:
        return 'Paylocity', {'id': m.group(1), 'company': m.group(2)}

    # ADP WorkforceNow (iframe-style portal)
    m = re.search(r'workforcenow\.adp\.com/[^\s"\'<>]+', combined, re.I)
    if m:
        adp_url = m.group(0)
        if not adp_url.startswith('http'):
            adp_url = 'https://' + adp_url
        return 'ADP', {'url': adp_url}

    # ADP myjobs portal (e.g. myjobs.adp.com/citb)
    m = re.search(r'myjobs\.adp\.com/([a-z0-9_-]+)', combined, re.I)
    if m:
        return 'ADP', {'url': f'https://myjobs.adp.com/{m.group(1)}'}

    # ApplicantPro
    m = re.search(r'([a-z0-9-]+)\.applicantpro\.com', combined, re.I)
    if m:
        return 'ApplicantPro', {'subdomain': m.group(1)}

    return None, None


def fetch_greenhouse(cfg, company_name):
    data = http_get_json(
        f"https://boards-api.greenhouse.io/v1/boards/{cfg['token']}/jobs?content=true"
    )
    if not data:
        return []
    jobs = []
    for j in data.get('jobs', []):
        loc = j.get('location', {}).get('name', '') or ''
        jobs.append(make_job(
            title=j.get('title', ''), company=company_name, location=loc,
            url=j.get('absolute_url', ''), source='Greenhouse',
            remote_type=norm_remote(loc + ' ' + j.get('title', '')),
        ))
    return jobs


def fetch_lever(cfg, company_name):
    company = cfg['company']
    # Try EU endpoint first if detected there, then US (or vice versa)
    hosts = ['https://api.lever.co/v0/postings', 'https://api.eu.lever.co/v0/postings']
    if cfg.get('eu'):
        hosts.reverse()
    data = None
    for host in hosts:
        data = http_get_json(f"{host}/{company}?mode=json")
        if isinstance(data, list):
            break
    if not isinstance(data, list):
        return []
    jobs = []
    for j in data:
        cats = j.get('categories', {})
        loc  = cats.get('location') or j.get('workplaceType') or ''
        jobs.append(make_job(
            title=j.get('text', ''), company=company_name, location=loc,
            dept=cats.get('team', ''), url=j.get('hostedUrl', ''),
            source='Lever', remote_type=norm_remote(str(loc)),
        ))
    return jobs


def fetch_ashby(cfg, company_name):
    slug = cfg['company']
    data = http_get_json(
        f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"
    )
    if not data:
        return []
    # Ashby API returns 'jobs'; older fallback key is 'jobPostings'
    postings = data.get('jobs') or data.get('jobPostings') or []
    jobs = []
    for j in postings:
        loc = j.get('location') or j.get('locationName') or ''
        # jobUrl/applyUrl are full URLs; jobPostingPath is a relative path
        job_url = j.get('jobUrl') or j.get('applyUrl') or j.get('jobPostingPath') or ''
        if job_url and not job_url.startswith('http'):
            job_url = f"https://jobs.ashbyhq.com/{slug}{job_url}"
        jobs.append(make_job(
            title=j.get('title', ''), company=company_name, location=loc,
            dept=j.get('departmentName', ''), url=job_url or f"https://jobs.ashbyhq.com/{slug}",
            source='Ashby', remote_type=norm_remote(str(loc)),
        ))
    return jobs


def fetch_smartrecruiters(cfg, company_name):
    data = http_get_json(
        f"https://api.smartrecruiters.com/v1/companies/{cfg['company']}/postings"
    )
    if not data:
        return []
    jobs = []
    for j in data.get('content', []):
        loc = j.get('location', {})
        loc_str = ', '.join(filter(None, [loc.get('city'), loc.get('region'), loc.get('country')]))
        jobs.append(make_job(
            title=j.get('name', ''), company=company_name, location=loc_str,
            dept=j.get('department', {}).get('label', ''), url=j.get('ref', ''),
            source='SmartRecruiters',
            remote_type=norm_remote(j.get('typeOfEmployment', {}).get('label', '')),
        ))
    return jobs


def fetch_bamboohr(cfg, company_name):
    sub  = cfg['subdomain']
    data = http_get_json(
        f"https://{sub}.bamboohr.com/careers/list",
        headers={'Accept': 'application/json'}
    )
    if not data:
        return []
    jobs = []
    for j in (data.get('result') or (data if isinstance(data, list) else [])):
        if not isinstance(j, dict):
            continue
        loc = j.get('location', {})
        loc_str = loc.get('city', '') if isinstance(loc, dict) else str(loc)
        jobs.append(make_job(
            title=j.get('jobOpeningName') or j.get('title', ''),
            company=company_name, location=loc_str,
            dept=j.get('departmentLabel', ''),
            url=f"https://{sub}.bamboohr.com/careers/{j.get('id', '')}",
            source='BambooHR',
        ))
    return jobs


def fetch_workday(cfg, company_name):
    tenant = cfg['tenant']
    wd     = cfg.get('wd') or 'wd5'
    site   = cfg.get('site') or tenant
    url    = f"https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs"
    offset, jobs = 0, []
    while True:
        data = http_post_json(url, {'appliedFacets': {}, 'limit': 20,
                                    'offset': offset, 'searchText': ''})
        if not data:
            break
        postings = data.get('jobPostings', [])
        if not postings:
            break
        for j in postings:
            loc = j.get('locationsText', '')
            if not loc and j.get('primaryLocations'):
                loc = j['primaryLocations'][0]
            jobs.append(make_job(
                title=j.get('title', ''), company=company_name,
                location=loc if isinstance(loc, str) else '',
                url=urljoin(
                    f"https://{tenant}.{wd}.myworkdayjobs.com/{tenant}/{site}/",
                    j.get('externalPath', '')
                ),
                source='Workday', remote_type=norm_remote(str(loc)),
            ))
        if len(postings) < 20:
            break
        offset += 20
        if offset > 200:
            break
    return jobs


def fetch_oracle(cfg, company_name):
    host = cfg.get('host') or ''
    site = cfg.get('siteNumber') or ''
    if not host:
        return []
    base_api = f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
    offset, jobs = 0, []
    while True:
        finder = (f"findReqs;siteNumber={site},limit=25,offset={offset}"
                  if site else f"findReqs;limit=25,offset={offset}")
        url = (f"{base_api}?onlyData=true"
               f"&expand=requisitionList.secondaryLocations&finder={finder}")
        data = http_get_json(url)
        if not data:
            break
        items = data.get('items', [])
        if not items:
            break
        for item in items:
            for req in item.get('requisitionList', [item]):
                title  = req.get('Title') or req.get('title', '')
                loc    = req.get('PrimaryLocation') or req.get('primaryLocation', '')
                req_id = req.get('Id') or req.get('id', '')
                jobs.append(make_job(
                    title=title, company=company_name, location=loc,
                    url=(f"https://{host}/hcmUI/CandidateExperience/en/sites/{site}"
                         f"/requisitions/{req_id}") if site else '',
                    source='Oracle',
                ))
        if len(items) < 25:
            break
        offset += 25
        if offset > 500:
            break
    return jobs


def fetch_jazzhr(cfg, company_name):
    html, final_url = http_get(f"https://{cfg['subdomain']}.applytojob.com/apply")
    if not html:
        return []
    return parse_html_jobs(html, final_url or '', company_name, source='JazzHR')


def fetch_icims(cfg, company_name):
    host = cfg.get('host')
    if not host:
        return []
    url = f"https://{host}/jobs/search"
    html, final_url = http_get(url)
    jobs = parse_html_jobs(html, final_url or url, company_name, source='iCIMS') if html else []
    return jobs or scrape_with_playwright(url, company_name)


def fetch_adp(cfg, company_name):
    """ADP WorkforceNow and myjobs portals are JS-rendered — use Playwright."""
    url = cfg.get('url', '')
    if not url:
        return []
    return scrape_with_playwright(url, company_name)


def fetch_applicantpro(cfg, company_name):
    sub = cfg['subdomain']
    url = f"https://{sub}.applicantpro.com/jobs/"
    html, final_url = http_get(url)
    if not html:
        return []
    return parse_html_jobs(html, final_url or url, company_name, source='ApplicantPro')


def fetch_rippling(cfg, company_name):
    """Rippling job boards are JS-rendered — Playwright required."""
    url = f"https://ats.rippling.com/{cfg['company']}/jobs"
    return scrape_with_playwright(url, company_name)


def fetch_workable(cfg, company_name):
    """Try Workable public JSON API first, fall back to Playwright."""
    slug = cfg['company']
    # Workable exposes a public API for published jobs
    data = http_get_json(f"https://apply.workable.com/api/v3/accounts/{slug}/jobs")
    if isinstance(data, dict) and data.get('results'):
        jobs = []
        for j in data['results']:
            loc = (j.get('location') or {})
            loc_str = loc.get('location_str') or loc.get('city') or ''
            url = j.get('url') or f"https://apply.workable.com/{slug}/j/{j.get('shortcode', '')}"
            jobs.append(make_job(
                title=j.get('title', ''), company=company_name, location=loc_str,
                dept=j.get('department', ''), url=url, source='Workable',
            ))
        return jobs
    # Fallback: render the public board page
    url = f"https://apply.workable.com/{slug}/"
    return scrape_with_playwright(url, company_name)


def fetch_paylocity(cfg, company_name):
    url = (f"https://recruiting.paylocity.com/recruiting/jobs/All"
           f"/{cfg['id']}/{cfg['company']}")
    html, final_url = http_get(url)
    jobs = parse_html_jobs(html, final_url or url, company_name, source='Paylocity') if html else []
    return jobs or scrape_with_playwright(url, company_name)


# ─────────────────────────────────────────────────────────────────────────────
# STAGE 2.5 — Indeed RSS (free, no API key required)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_indeed_rss(company_name):
    """Query Indeed's free public RSS feed for jobs matching the company name."""
    try:
        from urllib.parse import quote as urlquote
    except ImportError:
        from urllib import quote as urlquote

    query = f'"{company_name}"'
    url   = (f'https://www.indeed.com/rss?q={urlquote(query)}'
             f'&sort=date&limit=15&fromage=30')
    html, _ = http_get(url, timeout=10)
    if not html:
        return []

    # Significant words from company name used for relevance filtering
    co_words = [w for w in company_name.lower().split() if len(w) > 3]
    jobs = []

    for item_m in re.finditer(r'<item>(.*?)</item>', html, re.DOTALL):
        item_text = item_m.group(1)

        # Title — handle CDATA and plain
        title_m = (re.search(r'<title><!\[CDATA\[(.*?)\]\]></title>', item_text, re.DOTALL)
                   or re.search(r'<title>(.*?)</title>', item_text, re.DOTALL))
        if not title_m:
            continue
        raw_title = title_m.group(1).strip()

        # Indeed format: "Job Title - Company Name - City, ST"
        parts     = [p.strip() for p in raw_title.split(' - ')]
        job_title = parts[0] if parts else raw_title

        # Verify listing belongs to our target company
        match_target = ' '.join(parts[1:]).lower() if len(parts) > 1 else ''
        desc_m = (re.search(r'<description><!\[CDATA\[(.*?)\]\]></description>',
                             item_text, re.DOTALL)
                  or re.search(r'<description>(.*?)</description>', item_text, re.DOTALL))
        search_text = match_target + ' ' + (desc_m.group(1) if desc_m else '').lower()

        if co_words and not any(w in search_text for w in co_words):
            continue
        if not job_title or len(job_title) < 3:
            continue

        link_m = re.search(r'<link>(.*?)</link>', item_text)
        guid_m = re.search(r'<guid[^>]*>(.*?)</guid>', item_text)
        link   = ((link_m.group(1) if link_m else '') or
                  (guid_m.group(1) if guid_m else '')).strip()

        date_str = None
        date_m = re.search(r'<pubDate>(.*?)</pubDate>', item_text)
        if date_m:
            try:
                from email.utils import parsedate
                t = parsedate(date_m.group(1).strip())
                if t:
                    date_str = f'{t[0]}-{t[1]:02d}-{t[2]:02d}'
            except Exception:
                pass

        jobs.append(make_job(
            title=job_title, company=company_name,
            url=link, date_posted=date_str,
            source='Indeed',
        ))

    return jobs


ATS_HANDLERS = {
    'Greenhouse':      fetch_greenhouse,
    'Lever':           fetch_lever,
    'Ashby':           fetch_ashby,
    'SmartRecruiters': fetch_smartrecruiters,
    'BambooHR':        fetch_bamboohr,
    'Workday':         fetch_workday,
    'Oracle':          fetch_oracle,
    'JazzHR':          fetch_jazzhr,
    'iCIMS':           fetch_icims,
    'ADP':             fetch_adp,
    'ApplicantPro':    fetch_applicantpro,
    'Rippling':        fetch_rippling,
    'Workable':        fetch_workable,
    'Paylocity':       fetch_paylocity,
}

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 3a — Plain HTML parsing
# ─────────────────────────────────────────────────────────────────────────────

# Role/function words that strongly suggest a real job title
JOB_TITLE_WORDS = [
    'engineer', 'manager', 'analyst', 'coordinator', 'specialist', 'director',
    'developer', 'designer', 'consultant', 'officer', 'supervisor', 'technician',
    'operator', 'associate', 'recruiter', 'architect', 'scientist', 'inspector',
    'captain', 'pilot', 'superintendent', 'estimator', 'planner', 'scheduler',
    'welder', 'rigger', 'electrician', 'mechanic', 'surveyor', 'foreman',
    'dispatcher', 'administrator', 'vice president', 'chief ', 'head of',
    'senior ', 'principal ', 'lead ', 'staff ',
]

# Words that mean this is definitely NOT a job title (benefits, products, nav)
NON_JOB_TERMS = re.compile(
    r'\b(insurance|benefit|wage|dental|vision|health|pension|401k|tuition|'
    r'reimbursement|competitive|paid time|pto|parental leave|product|service|'
    r'solution|equipment|system|pump|valve|gauge|sensor|fabrication|about|'
    r'contact us|privacy|copyright|newsletter|learn more|read more|click here|'
    r'download|follow us|sign up|log in|subscribe|terms|cookie)\b',
    re.I
)


def _collect_jsonld_jobs(node):
    """Recursively yield JobPosting dicts from JSON-LD, handling @graph and arrays."""
    if isinstance(node, list):
        for item in node:
            yield from _collect_jsonld_jobs(item)
    elif isinstance(node, dict):
        typ = node.get('@type', '')
        types = typ if isinstance(typ, list) else [typ]
        if any(str(t).lower() == 'jobposting' for t in types):
            yield node
        else:
            if '@graph' in node:
                yield from _collect_jsonld_jobs(node['@graph'])
            if 'itemListElement' in node:
                yield from _collect_jsonld_jobs(node['itemListElement'])


def parse_html_jobs(html, page_url, company_name, source='Company Website'):
    if not html:
        return []
    jobs = []

    # JSON-LD structured data — most reliable when present
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE
    ):
        try:
            data = json.loads(m.group(1))
            for item in _collect_jsonld_jobs(data):
                title = (item.get('title') or '').strip()
                if not title:
                    continue
                loc_raw = item.get('jobLocation') or {}
                if isinstance(loc_raw, list):
                    loc_raw = loc_raw[0] if loc_raw else {}
                addr = loc_raw.get('address') or {}
                loc  = ', '.join(filter(None, [addr.get('addressLocality'),
                                               addr.get('addressRegion')]))
                dp   = (item.get('datePosted') or '')[:10]
                jobs.append(make_job(
                    title=title, company=company_name, location=loc,
                    url=item.get('url', page_url), source=source,
                    date_posted=dp or None,
                    remote_type='Remote' if item.get('jobLocationType') == 'TELECOMMUTE'
                                else 'Unknown',
                ))
        except Exception:
            continue

    if jobs:
        return jobs

    # BeautifulSoup — two passes
    if HAS_BS4:
        soup = parse_html(html)
        seen = set()

        # Pass 1: heading + li + anchor heuristic (strict — requires JOB_TITLE_WORDS)
        for tag in soup.find_all(['h1', 'h2', 'h3', 'h4', 'li', 'a']):
            text  = tag.get_text(' ', strip=True)
            words = text.split()
            tl    = text.lower()
            if (2 <= len(words) <= 9          # real job titles are 2–9 words
                    and 8 <= len(text) <= 75   # not too short, not too long
                    and any(kw in tl for kw in JOB_TITLE_WORDS)
                    and not NON_JOB_TERMS.search(text)
                    and text not in seen):
                seen.add(text)
                href = tag.get('href', '') if tag.name == 'a' else ''
                link = urljoin(page_url, href) if href else page_url
                jobs.append(make_job(title=text, company=company_name,
                                     url=link, source=source))

        if jobs:
            return jobs[:25]

        # Pass 2: job-link extraction — catches pages like Bray where job titles
        # are plain <a> links pointing at individual job-application/detail pages.
        # We require the href to look like a job-posting URL but relax the title rules.
        for a in soup.find_all('a', href=True):
            href = a['href'].strip()
            text = a.get_text(' ', strip=True)
            words = text.split()
            if not JOB_LISTING_HREF_RE.search(href):
                continue
            if not (2 <= len(words) <= 12 and 6 <= len(text) <= 100):
                continue
            if NON_JOB_TERMS.search(text):
                continue
            if text in seen:
                continue
            seen.add(text)
            jobs.append(make_job(title=text, company=company_name,
                                 url=urljoin(page_url, href), source=source))
        return jobs[:25]

    # Regex fallback (no BS4)
    seen = set()
    for m in re.finditer(r'<h[1-4][^>]*>([^<]{8,75})</h[1-4]>', html, re.I):
        text  = re.sub(r'\s+', ' ', m.group(1)).strip()
        words = text.split()
        if (2 <= len(words) <= 9
                and any(kw in text.lower() for kw in JOB_TITLE_WORDS)
                and not NON_JOB_TERMS.search(text)
                and text not in seen):
            seen.add(text)
            jobs.append(make_job(title=text, company=company_name,
                                 url=page_url, source=source))
    return jobs[:25]

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 3b — Playwright render (only when plain HTML returns nothing)
# ─────────────────────────────────────────────────────────────────────────────

PLAYWRIGHT_BROWSERS = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '/app/.playwright')

def _playwright_render(url, timeout_ms=15000):
    """Render a URL with Playwright. Returns (html, captured_json_list)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None, []

    captured = []

    def on_response(response):
        ct = response.headers.get('content-type', '')
        if 'json' in ct and response.status == 200 and len(captured) < 10:
            try:
                data = response.json()
                if isinstance(data, (list, dict)):
                    txt = json.dumps(data)[:500].lower()
                    if any(k in txt for k in ('title', 'job', 'posting', 'requisition', 'career')):
                        captured.append(data)
            except Exception:
                pass

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=_find_chromium(),
                headless=True,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
            )
            ctx = browser.new_context(
                user_agent=(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/120.0.0.0 Safari/537.36'
                )
            )
            page = ctx.new_page()
            page.on('response', on_response)
            page.goto(url, wait_until='networkidle', timeout=timeout_ms)
            html = page.content()
            browser.close()
        return html, captured
    except Exception:
        return None, []


def scrape_with_playwright(url, company_name):
    html, captured = _playwright_render(url)
    if not html:
        return []
    for data in captured:
        if _looks_like_jobs(data):
            jobs = _extract_from_xhr(data, url, company_name)
            if jobs:
                return jobs
    return parse_html_jobs(html, url, company_name, source='Company Website (rendered)')


def _find_chromium():
    import glob
    candidates = [
        os.path.join(PLAYWRIGHT_BROWSERS, 'chromium-*/chrome-linux/chrome'),
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/run/current-system/sw/bin/chromium',
    ]
    for pattern in candidates:
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    return None


def _looks_like_jobs(data):
    text = json.dumps(data)[:2000].lower()
    primary   = ('title', 'location', 'apply', 'posting', 'requisition')
    secondary = ('department', 'employment', 'salary', 'opening', 'position',
                 'vacancy', 'hiring', 'career', 'role', 'compensation')
    return (sum(1 for kw in primary if kw in text) >= 2 or
            sum(1 for kw in primary + secondary if kw in text) >= 3)


_XHR_CONTAINER_KEYS = (
    'jobs', 'jobPostings', 'results', 'openings', 'positions',
    'vacancies', 'data', 'postings', 'requisitions', 'jobRequisitions',
    'listings', 'opportunities', 'items', 'content', 'records',
)

def _extract_from_xhr(data, page_url, company_name):
    # Find the list of job items in various data structures
    items = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in _XHR_CONTAINER_KEYS:
            v = data.get(key)
            if isinstance(v, list) and v:
                items = v
                break
        # One level of nesting (e.g. {data: {jobs: [...]}})
        if not items:
            for v in data.values():
                if isinstance(v, dict):
                    for key in _XHR_CONTAINER_KEYS:
                        vv = v.get(key)
                        if isinstance(vv, list) and vv:
                            items = vv
                            break
                elif isinstance(v, list) and v and isinstance(v[0], dict):
                    if any(k in v[0] for k in ('title', 'name', 'jobTitle',
                                               'positionTitle', 'requisitionTitle')):
                        items = v
                if items:
                    break

    if not isinstance(items, list) or not items:
        return []

    jobs = []
    for j in items[:50]:
        if not isinstance(j, dict):
            continue
        title = (j.get('title') or j.get('name') or j.get('jobTitle') or
                 j.get('positionTitle') or j.get('requisitionTitle') or
                 j.get('jobName') or j.get('position') or j.get('role') or
                 j.get('jobPosition') or j.get('openingTitle') or '')
        if not title or len(str(title)) < 2:
            continue
        loc_raw = (j.get('location') or j.get('locationText') or j.get('city') or
                   j.get('locationName') or j.get('workLocation') or '')
        if isinstance(loc_raw, dict):
            loc = (loc_raw.get('name') or loc_raw.get('city') or
                   loc_raw.get('displayName') or loc_raw.get('country') or '')
        else:
            loc = str(loc_raw)
        job_url = (j.get('url') or j.get('applyUrl') or j.get('jobUrl') or
                   j.get('link') or j.get('applicationUrl') or j.get('externalUrl') or
                   j.get('hostedUrl') or page_url)
        jobs.append(make_job(
            title=str(title).strip(), company=company_name, location=loc,
            url=job_url,
            source='Company Website (XHR)',
        ))
    return jobs

# ─────────────────────────────────────────────────────────────────────────────
# STAGE 3c — LLM extraction via Claude (last resort)
# ─────────────────────────────────────────────────────────────────────────────

def extract_with_llm(html, page_url, company_name):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return []
    try:
        import anthropic
    except ImportError:
        return []

    clean = re.sub(r'<(script|style|nav|footer|header)[^>]*>.*?</\1>', '', html,
                   flags=re.DOTALL | re.IGNORECASE)
    clean = re.sub(r'<[^>]+>', ' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()[:30000]

    prompt = (
        f"Extract every open job listing from this careers page text. "
        f"Return ONLY a JSON array, no markdown fences, where each object has: "
        f"job_title, location, department, posting_date, salary_range, "
        f"job_url (resolve relative URLs against {page_url}). "
        f"If a field is missing use null. "
        f"If there are genuinely no job listings, return [].\n\n{clean}"
    )

    for attempt in range(2):
        try:
            client = anthropic.Anthropic(api_key=api_key)
            msg    = client.messages.create(
                model='claude-haiku-4-5-20251001',
                max_tokens=2000,
                messages=[{'role': 'user',
                           'content': prompt if attempt == 0
                           else prompt + '\n\nReturn valid JSON only, no explanation.'}]
            )
            raw  = msg.content[0].text.strip()
            raw  = re.sub(r'^```json\s*', '', raw)
            raw  = re.sub(r'```$', '', raw).strip()
            items = json.loads(raw)
            if not isinstance(items, list):
                continue
            jobs = []
            for j in items:
                title = j.get('job_title', '').strip()
                if title:
                    jobs.append(make_job(
                        title=title, company=company_name,
                        location=j.get('location') or '',
                        dept=j.get('department') or '',
                        url=j.get('job_url') or page_url,
                        date_posted=(j.get('posting_date') or '')[:10] or None,
                        salary=j.get('salary_range') or '',
                        source='LLM Extraction',
                    ))
            return jobs
        except Exception:
            continue
    return []

# ─────────────────────────────────────────────────────────────────────────────
# Main pipeline
# ─────────────────────────────────────────────────────────────────────────────

def scrape_company(company_name, homepage_url):
    # Stage 1a: find careers page (static HTTP)
    careers_url, careers_html = find_careers_url(homepage_url)
    method = 'failed'

    # Stage 1b: follow "View Job Opportunities" if careers page is a landing page
    if careers_url and careers_html:
        drill_url, drill_html = drill_to_listings(careers_html, careers_url)
        if drill_url and drill_url != careers_url:
            careers_url, careers_html = drill_url, drill_html

    # Stage 2: ATS detection on careers page, then homepage (static HTML only)
    ats_name, ats_cfg = detect_ats(careers_url, careers_html)
    if not ats_name and homepage_url:
        home_html, _ = (http_get(homepage_url)
                        if careers_url != homepage_url
                        else (careers_html, None))
        ats_name, ats_cfg = detect_ats(homepage_url, home_html)

    jobs = []
    if ats_name and ats_name in ATS_HANDLERS:
        try:
            jobs = ATS_HANDLERS[ats_name](ats_cfg, company_name)
            if jobs:
                method = ats_name
        except Exception:
            jobs = []

    # Stage 2.5: Indeed RSS — free secondary source when ATS/careers page found nothing
    if not jobs:
        indeed_jobs = fetch_indeed_rss(company_name)
        if indeed_jobs:
            jobs   = indeed_jobs
            method = 'indeed_rss'

    # Stage 3a: plain HTML parse
    if not jobs and careers_html:
        jobs = parse_html_jobs(careers_html, careers_url or '', company_name)
        if jobs:
            method = 'html_parse'

    # Stage 3b: Playwright render of careers page
    # Also re-runs ATS detection on the rendered HTML (catches JS-embedded ATS links
    # like ADP iframes that only appear after JavaScript executes)
    if not jobs and careers_url:
        rendered_html, rendered_json = _playwright_render(careers_url)
        if rendered_html:
            if not ats_name:
                new_ats, new_cfg = detect_ats(careers_url, rendered_html)
                if new_ats and new_ats in ATS_HANDLERS:
                    try:
                        jobs = ATS_HANDLERS[new_ats](new_cfg, company_name)
                        if jobs:
                            method = new_ats
                            ats_name = new_ats
                    except Exception:
                        pass
            if not jobs:
                for data in rendered_json:
                    if _looks_like_jobs(data):
                        xjobs = _extract_from_xhr(data, careers_url, company_name)
                        if xjobs:
                            jobs = xjobs
                            method = 'playwright'
                            break
            if not jobs:
                jobs = parse_html_jobs(rendered_html, careers_url, company_name,
                                       source='Company Website (rendered)')
                if jobs:
                    method = 'playwright'

    # Stage 4: Playwright-rendered homepage discovery
    # Runs only when static HTTP found no careers URL at all (SPA homepages where
    # navigation links are injected by JavaScript and invisible to static fetching)
    if not jobs and homepage_url and careers_url is None:
        rendered_home, _ = _playwright_render(homepage_url, timeout_ms=8000)
        if rendered_home:
            # ATS detection on rendered homepage (catches JS-loaded ADP/iCIMS links)
            new_ats2, new_cfg2 = detect_ats(homepage_url, rendered_home)
            if new_ats2 and new_ats2 in ATS_HANDLERS:
                try:
                    jobs = ATS_HANDLERS[new_ats2](new_cfg2, company_name)
                    if jobs:
                        method = new_ats2
                except Exception:
                    pass
            # Find careers link from rendered homepage HTML
            if not jobs and HAS_BS4:
                soup = parse_html(rendered_home)
                home_candidates = []
                for a in soup.find_all('a', href=True):
                    text = a.get_text(' ', strip=True)
                    href = a['href'].strip()
                    if not href or href.startswith('#') or 'javascript' in href.lower():
                        continue
                    full_url = urljoin(homepage_url, href)
                    score = 0
                    if CAREER_KEYWORDS.search(text):
                        score += 3
                    if CAREER_KEYWORDS.search(href):
                        score += 2
                    if score:
                        home_candidates.append((score, full_url))
                for _s, cand_url in sorted(home_candidates, reverse=True)[:3]:
                    cand_domain = urlparse(cand_url).netloc
                    home_domain = urlparse(homepage_url).netloc
                    if cand_domain and cand_domain != home_domain:
                        # Off-domain link — check if it's a known ATS
                        ext_ats, ext_cfg = detect_ats(cand_url, '')
                        if ext_ats and ext_ats in ATS_HANDLERS:
                            try:
                                jobs = ATS_HANDLERS[ext_ats](ext_cfg, company_name)
                                if jobs:
                                    method = ext_ats
                                    careers_url = cand_url
                                    break
                            except Exception:
                                pass
                    else:
                        new_jobs = scrape_with_playwright(cand_url, company_name)
                        if new_jobs:
                            jobs = new_jobs
                            careers_url = cand_url
                            method = 'playwright'
                            break

    # Stage 3c: LLM extraction (last resort, only if we have careers HTML)
    if not jobs and careers_html:
        jobs = extract_with_llm(careers_html, careers_url or '', company_name)
        if jobs:
            method = 'llm_extraction'

    return jobs, method, careers_url

# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    # Hard deadline — Python exits cleanly before Node.js kills the process.
    # SIGALRM is Linux-only; skip silently on Windows.
    try:
        import signal
        def _alarm(sig, frame):
            print(json.dumps({'data': [], 'total': 0, 'error': 'timeout',
                              'method': 'timeout', 'careersUrl': ''}))
            sys.exit(0)
        signal.signal(signal.SIGALRM, _alarm)
        signal.alarm(35)
    except (AttributeError, OSError):
        pass

    company_name = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    homepage_url = sys.argv[2].strip() if len(sys.argv) > 2 else ''

    if not company_name:
        print(json.dumps({'data': [], 'total': 0, 'error': 'No company name provided'}))
        return

    try:
        jobs, method, careers_url = scrape_company(company_name, homepage_url)
        print(json.dumps({
            'data':       jobs,
            'total':      len(jobs),
            'method':     method,
            'careersUrl': careers_url or '',
        }))
    except Exception as e:
        print(json.dumps({'data': [], 'total': 0, 'error': str(e)}))


if __name__ == '__main__':
    main()
