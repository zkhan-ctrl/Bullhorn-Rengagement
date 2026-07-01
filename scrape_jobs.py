#!/usr/bin/env python3
"""
Called by server.js via subprocess.
Usage: python3 scrape_jobs.py "Company Name"
Outputs JSON to stdout: { "data": [...], "total": N }
"""
import sys
import json

def main():
    company = sys.argv[1].strip() if len(sys.argv) > 1 else ''
    if not company:
        print(json.dumps({'data': [], 'total': 0, 'error': 'No company name provided'}))
        return

    try:
        from jobspy import scrape_jobs

        jobs_df = scrape_jobs(
            site_name=['indeed', 'linkedin', 'zip_recruiter', 'glassdoor'],
            search_term=f'"{company}"',
            results_wanted=20,
            hours_old=720,     # 30 days
            country_indeed='USA',
            verbose=0
        )

        result = []
        company_lower = company.lower()

        for _, row in jobs_df.iterrows():
            # Only keep results that are actually for this company
            row_company = str(row.get('company') or '').lower()
            name_match = (
                company_lower[:10] in row_company or
                row_company[:10] in company_lower or
                any(w in row_company for w in company_lower.split() if len(w) > 3)
            )
            if not name_match:
                continue

            date_posted = row.get('date_posted')
            date_str    = str(date_posted) if date_posted and str(date_posted) not in ('NaT', 'None', '') else None

            job_type = str(row.get('job_type') or '').replace('JobType.', '').replace('_', '-').title() or 'Full-time'

            result.append({
                'title':      str(row.get('title')    or ''),
                'location':   str(row.get('location') or ''),
                'type':       job_type,
                'url':        str(row.get('job_url')  or ''),
                'source':     str(row.get('site')     or '').replace('_', ' ').title(),
                'datePosted': date_str,
                'isRemote':   bool(row.get('is_remote')),
            })

        print(json.dumps({'data': result, 'total': len(result)}))

    except ImportError as e:
        print(json.dumps({'data': [], 'total': 0, 'error': f'jobspy not installed: {e}'}))
    except Exception as e:
        print(json.dumps({'data': [], 'total': 0, 'error': str(e)}))

if __name__ == '__main__':
    main()
