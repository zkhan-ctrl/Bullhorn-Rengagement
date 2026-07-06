#!/usr/bin/env python3
"""
Multi-source job scraper for CGR Re-Engagement Tool.
Usage: python3 scrape_jobs.py "Company Name" [website_url]
Sources (in priority order):
  1. Indeed RSS       -- free, no auth, reliable from cloud IPs
  2. Monster          -- HTML scrape of monster.com/jobs/search
  3. Company website  -- career page scrape (JSON-LD + heading heuristics)
  4. JobSpy           -- LinkedIn / Glassdoor / ZipRecruiter (best-effort from cloud)
Outputs JSON: { "data": [...], "total": N, "sources": [...] }
"""
import sys
import json
import re
from datetime import datetime, date, timedelta
from urllib.request import urlopen, Request
from urllib.parse import quote_plus, urlparse
import xml.etree.ElementTree as ET

# ── Shared helpers ─────────────────────────────────────────────────────────────

BROWSER_UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/124.0.0.0 Safari/537.36'
)

def clean_name(raw):
    s = re.sub(r'^[A-Z0-9&\.\s]{1,10}\s*[-–]\s+', '', raw)
    s = re.sub(
        r',?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.|PLLC|PLC|Company|Corporation|'
        r'Group|International|Intl\.?|Solutions|Services|Technologies?)$',
        '', s, flags=re.IGNORECASE
    )
    s = s.strip()
    return s if len(s) > 3 else raw.strip()

def significant_words(s):
    STOPS = {'the', 'and', 'for', 'inc', 'llc', 'ltd', 'corp', 'company', 'pllc'}
    return {w for w in re.findall(r'[a-z]{3,}', s.lower()) if w not in STOPS}

def days_since(date_val):
    if date_val is None:
        return None
    s = str(date_val)
    if s in ('NaT', 'None', '', 'nan'):
        return None
    try:
        if hasattr(date_val, 'date'):
            d = date_val.date()
        elif hasattr(date_val, 'year'):
            d = date_val
        else:
            d = datetime.strptime(s[:10], '%Y-%m-%d').date()
        return max(0, (date.today() - d).days)
    except Exception:
        return None

def http_get(url, timeout=12, extra_headers=None):
    headers = {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    if extra_headers:
        headers.update(extra_headers)
    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as resp:
            charset = 'utf-8'
            ct = resp.headers.get('Content-Type', '')
            m = re.search(r'charset=([^\s;]+)', ct)
            if m:
                charset = m.group(1).strip('"\'')
            return resp.read().decode(charset, errors='replace'), resp.url
    except Exception:
        return None, None

def make_job(title, company='', location='', job_type='Full-time',
             url='', source='', date_posted=None, days_posted=None, remote=False):
    return {
        'title':      title,
        'company':    company,
        'location':   location,
        'type':       job_type,
        'url':        url,
        'source':     source,
        'datePosted': date_posted,
        'daysPosted': days_posted,
        'isRemote':   remote,
    }

# ── Source 1: Indeed RSS ───────────────────────────────────────────────────────

def scrape_indeed(company_name):
    q = quote_plus(f'"{company_name}"')
    url = f'https://www.indeed.com/rss?q={q}&sort=date&limit=25'
    html, _ = http_get(url, extra_headers={
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
    })
    if not html:
        return []
    try:
        root = ET.fromstring(html)
    except ET.ParseError:
        return []

    match_words = significant_words(company_name)
    jobs = []

    for item in root.findall('.//item'):
        title_raw = (item.findtext('title') or '').strip()
        if not title_raw or title_raw.lower() in ('jobs', 'indeed jobs'):
            continue

        # Indeed RSS: "Job Title - Company Name"
        parts = re.split(r'\s+[-–]\s+', title_raw, maxsplit=1)
        job_title = parts[0].strip()
        posting_co = parts[1].strip() if len(parts) > 1 else ''

        # Filter: company name words must match
        if posting_co and match_words:
            if not (match_words & significant_words(posting_co)):
                continue

        link = (item.findtext('link') or '').strip()
        pub_date = (item.findtext('pubDate') or '').strip()
        dp, date_str = None, None
        for fmt in ('%a, %d %b %Y %H:%M:%S %z', '%a, %d %b %Y %H:%M:%S GMT'):
            try:
                d = datetime.strptime(pub_date[:31], fmt).date()
                dp = max(0, (date.today() - d).days)
                date_str = d.isoformat()
                break
            except Exception:
                continue

        jobs.append(make_job(
            title=job_title, company=posting_co, url=link,
            source='Indeed', date_posted=date_str, days_posted=dp,
        ))
    return jobs

# ── Source 2: Monster HTML scrape ─────────────────────────────────────────────

def scrape_monster(company_name):
    q = quote_plus(company_name)
    url = f'https://www.monster.com/jobs/search?q={q}&where=usa&sort=date'
    html, _ = http_get(url)
    if not html:
        return []

    jobs = []

    # Try JSON-LD structured data first
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE
    ):
        try:
            data = json.loads(m.group(1))
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get('@type') == 'JobPosting':
                    title = (item.get('title') or '').strip()
                    if not title:
                        continue
                    org = item.get('hiringOrganization') or {}
                    loc = item.get('jobLocation') or {}
                    if isinstance(loc, list):
                        loc = loc[0] if loc else {}
                    addr = loc.get('address') or {}
                    location = ', '.join(filter(None, [
                        addr.get('addressLocality', ''),
                        addr.get('addressRegion', '')
                    ]))
                    dp_str = (item.get('datePosted') or '')[:10]
                    jobs.append(make_job(
                        title=title,
                        company=org.get('name', '') if isinstance(org, dict) else '',
                        location=location,
                        url=item.get('url', url),
                        source='Monster',
                        date_posted=dp_str or None,
                        days_posted=days_since(dp_str) if dp_str else None,
                    ))
        except Exception:
            continue

    if jobs:
        return jobs

    # Fallback: heading tags with job-title class
    seen = set()
    for m in re.finditer(
        r'<(?:h[1-4]|a)\b[^>]+class=["\'][^"\']*(?:job-title|jobTitle|title)[^"\']*["\'][^>]*>'
        r'\s*([^<]{5,120})\s*</',
        html, re.IGNORECASE
    ):
        title = m.group(1).strip()
        if title and title not in seen:
            seen.add(title)
            jobs.append(make_job(title=title, source='Monster', url=url))

    return jobs[:20]

# ── Source 3: Company career page ─────────────────────────────────────────────

CAREER_PATHS = [
    '/careers', '/jobs', '/career', '/openings', '/opportunities',
    '/join-us', '/work-with-us', '/current-openings', '/open-positions',
    '/hiring', '/employment', '/about/careers', '/company/careers',
    '/careers/open-positions', '/careers/', '/jobs/',
]

JOB_KWS = [
    'engineer', 'manager', 'analyst', 'coordinator', 'specialist', 'director',
    'developer', 'designer', 'consultant', 'officer', 'supervisor', 'technician',
    'operator', 'associate', 'recruiter', 'architect', 'scientist', 'inspector',
    'captain', 'pilot', 'superintendent', 'estimator', 'planner', 'scheduler',
    'senior ', 'vice president', 'chief ', 'head of',
]

def parse_career_page(html, page_url):
    jobs = []

    # JSON-LD JobPosting
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE
    ):
        try:
            data = json.loads(m.group(1))
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get('@type') == 'JobPosting':
                    title = (item.get('title') or '').strip()
                    if title:
                        dp_str = (item.get('datePosted') or '')[:10]
                        jobs.append(make_job(
                            title=title,
                            url=item.get('url', page_url),
                            source='Company Website',
                            date_posted=dp_str or None,
                            days_posted=days_since(dp_str) if dp_str else None,
                            remote=item.get('jobLocationType') == 'TELECOMMUTE',
                        ))
        except Exception:
            continue

    if jobs:
        return jobs

    # Heading heuristic
    seen = set()
    for m in re.finditer(r'<h[1-4][^>]*>([^<]{8,120})</h[1-4]>', html, re.IGNORECASE):
        text = re.sub(r'\s+', ' ', m.group(1)).strip()
        tl = text.lower()
        if any(kw in tl for kw in JOB_KWS) and text not in seen:
            seen.add(text)
            jobs.append(make_job(title=text, source='Company Website', url=page_url))

    return jobs[:20]

def scrape_career_page(website_url):
    if not website_url:
        return []
    if '://' not in website_url:
        website_url = 'https://' + website_url
    parsed = urlparse(website_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    # Look for careers link on homepage first
    home_html, _ = http_get(base, timeout=10)
    if home_html:
        for m in re.finditer(
            r'<a[^>]+href=["\']([^"\'#?]+)["\'][^>]*>([^<]{3,40})</a>',
            home_html, re.IGNORECASE
        ):
            href, text = m.group(1), m.group(2).strip()
            if re.search(r'\b(career|jobs?|openings?|opportunities|hiring)\b', text, re.I):
                target = href if href.startswith('http') else base + href
                html, final_url = http_get(target, timeout=10)
                if html:
                    jobs = parse_career_page(html, final_url or target)
                    if jobs:
                        return jobs

    # Brute-force common paths
    for path in CAREER_PATHS:
        html, final_url = http_get(base + path, timeout=10)
        if html and len(html) > 800:
            jobs = parse_career_page(html, final_url or base + path)
            if jobs:
                return jobs

    return []

# ── Source 4: JobSpy (LinkedIn / Glassdoor / ZipRecruiter) ────────────────────

def scrape_jobspy(search_name, match_words):
    try:
        from jobspy import scrape_jobs
        jobs_df = scrape_jobs(
            site_name=['linkedin', 'glassdoor', 'zip_recruiter'],
            search_term=search_name,
            results_wanted=30,
            hours_old=720,
            country_indeed='USA',
            verbose=0
        )
        results = []
        for _, row in jobs_df.iterrows():
            row_company = str(row.get('company') or '').strip()
            if not row_company:
                continue
            if match_words and not (match_words & significant_words(row_company)):
                continue
            dp = days_since(row.get('date_posted'))
            date_str = None
            if dp is not None:
                try:
                    date_str = (date.today() - timedelta(days=dp)).isoformat()
                except Exception:
                    pass
            site = str(row.get('site') or '').replace('_', ' ').title()
            jtype = (
                str(row.get('job_type') or '')
                .replace('JobType.', '').replace('_', '-').title()
            ) or 'Full-time'
            results.append(make_job(
                title=str(row.get('title') or ''),
                company=row_company,
                location=str(row.get('location') or ''),
                job_type=jtype,
                url=str(row.get('job_url') or ''),
                source=site,
                date_posted=date_str,
                days_posted=dp,
                remote=bool(row.get('is_remote')),
            ))
        return results
    except Exception:
        return []

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    raw_company = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    website_url = sys.argv[2].strip() if len(sys.argv) > 2 else ''

    if not raw_company:
        print(json.dumps({'data': [], 'total': 0, 'error': 'No company name provided'}))
        return

    search_name = clean_name(raw_company)
    match_words = significant_words(search_name) | significant_words(raw_company)

    all_jobs = []
    seen = set()
    sources_hit = []

    def add(jobs, label):
        count = 0
        for j in jobs:
            key = (j['title'].lower().strip(), j['source'])
            if key not in seen and j['title'].strip():
                seen.add(key)
                all_jobs.append(j)
                count += 1
        if count:
            sources_hit.append(f"{label}:{count}")

    add(scrape_indeed(search_name),           'Indeed')
    add(scrape_monster(search_name),          'Monster')
    add(scrape_career_page(website_url),      'Website')
    add(scrape_jobspy(search_name, match_words), 'JobSpy')

    print(json.dumps({'data': all_jobs, 'total': len(all_jobs), 'sources': sources_hit}))

if __name__ == '__main__':
    main()
