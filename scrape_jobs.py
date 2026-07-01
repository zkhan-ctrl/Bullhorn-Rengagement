#!/usr/bin/env python3
"""
Called by server.js via subprocess.
Usage: python3 scrape_jobs.py "Company Name"
Outputs JSON to stdout: { "data": [...], "total": N }
"""
import sys
import json
import re
from datetime import datetime, date

def clean_name(raw):
    """
    Strip common prefix abbreviations and legal suffixes so searches are broader.
    "ABS - American Bureau of Shipping" -> "American Bureau of Shipping"
    "CGR - Core Group Resources, Inc."  -> "Core Group Resources"
    """
    # Remove leading abbreviation block like "ABS - " or "CGR - "
    s = re.sub(r'^[A-Z0-9&\.\s]{1,10}\s*[-–]\s+', '', raw)
    # Remove trailing legal suffixes
    s = re.sub(
        r',?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.|Company|Corporation|'
        r'Group|International|Intl\.?|Solutions|Services|Technologies?)$',
        '', s, flags=re.IGNORECASE
    )
    s = s.strip()
    # If nothing useful survived, fall back to the original
    return s if len(s) > 3 else raw.strip()

def significant_words(s):
    """Return set of lowercase words with 3+ chars (skip stop words)."""
    STOPS = {'the', 'and', 'for', 'inc', 'llc', 'ltd', 'corp', 'company'}
    return {w for w in re.findall(r'[a-z]{3,}', s.lower()) if w not in STOPS}

def days_since(date_val):
    """Return integer days since date_val, or None if unparseable."""
    if date_val is None:
        return None
    s = str(date_val)
    if s in ('NaT', 'None', '', 'nan'):
        return None
    try:
        if hasattr(date_val, 'date'):           # pandas Timestamp
            d = date_val.date()
        elif hasattr(date_val, 'year'):          # datetime.date
            d = date_val
        else:
            d = datetime.strptime(s[:10], '%Y-%m-%d').date()
        return max(0, (date.today() - d).days)
    except Exception:
        return None

def main():
    raw_company = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    if not raw_company:
        print(json.dumps({'data': [], 'total': 0, 'error': 'No company name provided'}))
        return

    search_name = clean_name(raw_company)
    # Words from both the cleaned name and the original (union) for matching
    match_words = significant_words(search_name) | significant_words(raw_company)

    try:
        from jobspy import scrape_jobs

        jobs_df = scrape_jobs(
            site_name=['linkedin', 'indeed', 'zip_recruiter', 'glassdoor'],
            search_term=search_name,   # no quotes — broader match
            results_wanted=40,
            hours_old=2160,            # 90 days
            country_indeed='USA',
            verbose=0
        )

        result = []
        for _, row in jobs_df.iterrows():
            row_company = str(row.get('company') or '').strip()
            if not row_company:
                continue
            # Keep the result if any significant word from our company name
            # appears in the posting's company field
            if not (match_words & significant_words(row_company)):
                continue

            dp = days_since(row.get('date_posted'))
            date_str = None
            if dp is not None:
                date_str = (date.today()
                            if dp == 0
                            else datetime.fromordinal(date.today().toordinal() - dp).date()
                           ).isoformat()

            job_type = (str(row.get('job_type') or '')
                        .replace('JobType.', '')
                        .replace('_', '-')
                        .title()) or 'Full-time'

            result.append({
                'title':      str(row.get('title')    or ''),
                'company':    row_company,
                'location':   str(row.get('location') or ''),
                'type':       job_type,
                'url':        str(row.get('job_url')  or ''),
                'source':     str(row.get('site')     or '').replace('_', ' ').title(),
                'datePosted': date_str,
                'daysPosted': dp,
                'isRemote':   bool(row.get('is_remote')),
            })

        print(json.dumps({'data': result, 'total': len(result)}))

    except ImportError as e:
        print(json.dumps({'data': [], 'total': 0, 'error': f'jobspy not installed: {e}'}))
    except Exception as e:
        print(json.dumps({'data': [], 'total': 0, 'error': str(e)}))

if __name__ == '__main__':
    main()
