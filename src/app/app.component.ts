import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Component } from '@angular/core';
import * as csv from 'csvtojson';
import { parse } from 'json2csv';
import { combineLatest, from, map, Observable, share, startWith, Subject, switchMap, tap } from 'rxjs';

const POINTS_PER_SPRINT = 2;

interface CapturedIssue {
  value: Issue;
  weightBefore: number;
  weightAfter: number;
}

interface Bucket {
  weight: number;
  issues: CapturedIssue[];
}

enum Priority {
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High',
  CRITICAL = 'Critical',
}

enum IssueType {
  STORY = 'Story',
  EPIC = 'Epic',
}

interface RawIssue {
  key: string;
  points: string;
  priority: Priority;
  summary: string;
  sprint: string;
  status: string;
  type: IssueType;
  epic: string;
  dependencies: string;
}

interface Issue {
  key: string;
  points: number;
  priority: Priority;
  summary: string;
  sprint: string;
  status: string;
  type: IssueType;
  epic: string;
  dependencies: Map<string, Issue>;
  nestedDependencies: Map<string, Issue>;
  dependencyOf: Map<string, Issue>;
  nestedDependencyOf: Map<string, Issue>;
  dependencyKeys: string[];
}

interface IssueUI extends Issue {

}

interface CapturedIssueUI extends CapturedIssue {
  value: IssueUI;
  hovered?: boolean;
  clicked?: boolean;
  isDependent?: boolean;
  hasDependency?: boolean;
  width: string;
  horizontalOffset: string;
}

interface BucketUI extends Bucket {
  issues: CapturedIssueUI[];
}

interface PointMarkerUI {
  points: number;
  position: string;
  sprint: number;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  title = 'jira-tracker';

  issueMap$: Observable<Map<string, Issue>>;
  epicMap$: Observable<Map<string, Map<string, Issue>>>;
  buckets$: Observable<Bucket[]>;
  bucketsUI$: Observable<BucketUI[]>;

  pointMarkers$: Observable<PointMarkerUI[]>;
  bucketsWidth$: Observable<string>;

  hovered$ = new Subject<CapturedIssueUI | null>();
  clicked$ = new Subject<CapturedIssueUI | null>();

  epicColors: Record<string, string | undefined> = {};
  
  constructor(private readonly httpClient: HttpClient) {
    const options: {
      headers?: HttpHeaders;
      observe?: 'body';
      params?: HttpParams;
      reportProgress?: boolean;
      responseType: 'text';
      withCredentials?: boolean;
    } = {
      responseType: 'text',
    };

    const source$ = this.httpClient
      .get('./assets/private/dependencies.csv', options)
      .pipe(
        switchMap((file) =>
          from(csv().fromString(file) as unknown as Promise<RawIssue[]>)
        ),
        map((rawIssues) =>
          rawIssues.map((rawIssue) => this.getIssue(rawIssue))
        ),
        map((issues) => {
          return issues.slice(0).sort(this.compareIssues.bind(this));
        }),
        map((issues) => {
          return issues.slice(0).sort(this.compareIssueDependencies.bind(this));
        }),
        map((issues) => {
          const issueMap = new Map<string, Issue>();
          const epicMap = new Map<string, Map<string, Issue>>();

          issues.forEach((issue) => {
            issueMap.set(issue.key, issue);

            if (issue.type === IssueType.EPIC) {
              if (!epicMap.has(issue.key)) {
                epicMap.set(issue.key, new Map<string, Issue>());
              }
            }

            if (issue.epic) {
              if (!epicMap.has(issue.epic)) {
                epicMap.set(issue.epic, new Map<string, Issue>());
              }
              epicMap.get(issue.epic)!.set(issue.key, issue);
            }
          });

          

          // https://material.io/design/color/the-color-system.html#tools-for-picking-colors

          const colors = [
            "#EF5350",
            "#EC407A",
            "#BA68C8",
            "#9575CD",
            "#7986CB",
            "#1E88E5",
            "#26A69A",
            "#66BB6A",
            "#CDDC39",
            "#FF7043",
            // "#90A4AE"// Used if no epic
          ];

          this.getArrayFromMap(epicMap).forEach(({value, key}, index) => {
            this.epicColors[key] = colors[index % colors.length];
          });

          return { issueMap, epicMap };
        }),
        map(({ issueMap, epicMap }) => {
          this.validateDependencies(issueMap);

          issueMap.forEach((issue) => {
            issue.dependencyKeys.forEach((dependencyKey) => {
              const dependency = issueMap.get(dependencyKey);

              if (!dependency) {
                console.error(issue, dependencyKey);
                throw new Error('Unexpected missing issue');
              }

              if (issue.key === dependencyKey) {
                console.error(issue, dependencyKey);
                throw new Error('Unexpected circular dependency');
              }

              // // Skip Epics since we will attach its issues as dependencies instead
              if (dependency.type !== IssueType.EPIC) {
                issue.dependencies.set(dependencyKey, dependency);
                dependency.dependencyOf.set(issue.key, issue);
              }

              if (dependency.type === IssueType.EPIC) {
                const epicIssueMap = epicMap.get(dependency.key);
                if (epicIssueMap) {
                  this.getArrayFromMap(epicIssueMap).forEach(
                    ({ value: epicDependency }) => {
                      if (issue.key === epicDependency.key) {
                        console.error({
                          issue,
                          epicDependency,
                          issueMap,
                          epicMap,
                        });
                        throw new Error('Unexpected circular dependency');
                      }
  
                      issue.dependencies.set(epicDependency.key, epicDependency);
                      epicDependency.dependencyOf.set(issue.key, issue);
                    }
                  );
                } else {
                  console.warn("Unexpected missing dependency key for epic map", dependency.key);
                }
              }
            });
          });

          issueMap.forEach((issue) => {
            const nestedDependencies = this.getFlattenedDependencies(issue);

            nestedDependencies.forEach((dependency) => {
              issue.nestedDependencies.set(dependency.key, dependency);
              dependency.nestedDependencyOf.set(issue.key, issue);
            });
          });

          return { issueMap, epicMap };
        }),
        map(({ issueMap, epicMap }) => {
          this.validateDependencies(issueMap);

          const issues = this.getArrayFromMap(issueMap).map(
            ({ value }) => value
          );

          const buckets = this.getBuckets(
            issues.filter((issue) => issue.type !== IssueType.EPIC)
          );

          return { issueMap, epicMap, buckets };
        }),
        tap(console.log),
        share()
      );

    this.issueMap$ = source$.pipe(map((source) => source.issueMap), share());

    this.epicMap$ = source$.pipe(map((source) => source.epicMap), share());

    this.buckets$ = source$.pipe(map((source) => source.buckets), share());

    const heaviestBucketWeight$ = this.buckets$.pipe(
      map((buckets) => this.getHeaviestBucket(buckets)),
      map((filteredBucket) => filteredBucket?.weight ?? 0),
    );

    this.bucketsWidth$ = heaviestBucketWeight$.pipe(
      map((filteredBucketWeight) => `${filteredBucketWeight * 100}px`)
    );

    this.pointMarkers$ = heaviestBucketWeight$.pipe(
      map((filteredBucketWeight) => {
        return Array.from({ length: filteredBucketWeight + 1 }, (_, i) => ({
          points: i,
          position: `${i * 100}px`,
          sprint: i % POINTS_PER_SPRINT === 0 ? (i / POINTS_PER_SPRINT + 1) : 0
        }));
      })
    );

    this.bucketsUI$ = combineLatest([
      this.buckets$,
      this.hovered$.pipe(startWith(null)),
      this.clicked$.pipe(startWith(null)),
    ]).pipe(
      map(([buckets, hoveredCapturedIssue, clickedCapturedIssue]) => {
        const showDependentsFor = hoveredCapturedIssue ?? clickedCapturedIssue;

        return buckets.map(bucket => {
          const issues: CapturedIssueUI[] = bucket.issues.map(issue => ({
            ...issue,
            clicked: !!clickedCapturedIssue?.value.key && (clickedCapturedIssue?.value.key === issue.value.key),
            hovered: !!hoveredCapturedIssue?.value.key && (hoveredCapturedIssue?.value.key === issue.value.key),
            isDependent: showDependentsFor?.value.nestedDependencies.has(issue.value.key) ?? false,
            hasDependency: showDependentsFor?.value.key ? issue?.value.nestedDependencies.has(showDependentsFor.value.key) : false,
            width: `${issue.value.points * 100}px`,
            horizontalOffset: `${issue.weightBefore * 100}px`,
          }));

          return {
            ...bucket,
            issues,
          };
        });
      })
    )
  }

  zeroOrNaN(value: number): boolean {
    if (!value) {
      return true;
    }

    if (isNaN(value)) {
      return true;
    }

    return false;
  }

  getIssue(rawIssue: RawIssue): Issue {
    const points = +rawIssue.points;

    const pointsHasIssues = this.zeroOrNaN(points);

    if (pointsHasIssues && rawIssue.type !== IssueType.EPIC) {
      console.warn("Unexpected issue has no points, going to default to .5pt");
    }

    const useablePoints = pointsHasIssues ? .5 : points;

    return {
      ...rawIssue,
      points: useablePoints,
      dependencies: new Map<string, Issue>(),
      nestedDependencies: new Map<string, Issue>(),
      dependencyOf: new Map<string, Issue>(),
      nestedDependencyOf: new Map<string, Issue>(),
      dependencyKeys: rawIssue.dependencies
        .split(',')
        .map((dirtyDependencyKey) => dirtyDependencyKey.trim())
        .filter((possiblyEmptyDependencyKey) => !!possiblyEmptyDependencyKey)
        .filter((dependencyKey) => {
          if (dependencyKey === rawIssue.key) {
            console.error(rawIssue);
            throw new Error('Detected Issue that depends on itself');
          }

          return true;
        }),
    };
  }

  getLightestBucket(buckets: Bucket[]): Bucket | undefined {
    if (!buckets.length) {
      return undefined;
    }

    return buckets.reduce((acc, loc) => {
      if (!acc) {
        return loc;
      }

      if (!loc) {
        return acc;
      }

      if (acc.weight < loc.weight) {
        return acc;
      } else {
        return loc;
      }
    });
  }

  getHeaviestCapturedIssue(
    capturedIssues: CapturedIssue[]
  ): CapturedIssue | undefined {
    if (!capturedIssues.length) {
      return undefined;
    }

    return capturedIssues.reduce((acc, loc) => {
      if (!acc) {
        return loc;
      }

      if (!loc) {
        return acc;
      }

      if (acc.weightAfter > loc.weightAfter) {
        return acc;
      } else {
        return loc;
      }
    });
  }

  getHeaviestBucket(buckets: Bucket[]): Bucket | undefined {
    if (!buckets.length) {
      return undefined;
    }

    return buckets.reduce((acc, loc) => {
      if (!acc) {
        return loc;
      }

      if (!loc) {
        return acc;
      }

      if (acc.weight > loc.weight) {
        return acc;
      } else {
        return loc;
      }
    });
  }

  getAllCapturedIssues(buckets: Bucket[]): CapturedIssue[] {
    return buckets.map((bucket) => bucket.issues).flat();
  }

  getPriorityNumericValue(priority: Priority): number {
    switch (priority) {
      case Priority.CRITICAL:
        return 4;
      case Priority.HIGH:
        return 3;
      case Priority.MEDIUM:
        return 2;
      case Priority.LOW:
        return 1;
      default:
        return 0;
    }
  }

  compareIssues(a: Issue, b: Issue): number {
    const priorityA = this.getPriorityNumericValue(a.priority);
    const priorityB = this.getPriorityNumericValue(b.priority);

    const priorityDelta = priorityB - priorityA;

    if (!priorityDelta) {
      return a.points - b.points;
    }

    return priorityDelta;
  }

  compareIssueDependencies(a: Issue, b: Issue): number {
    return b.nestedDependencyOf.size - a.nestedDependencyOf.size;
  }

  getFlattenedDependencies(issue: Issue): Issue[] {
    if (!issue.dependencies.size) {
      return [];
    }

    const dependencies = this.getArrayFromMap(issue.dependencies).map(
      ({ value }) => value
    );

    return [
      ...dependencies,
      ...dependencies
        .map((dependency) => this.getFlattenedDependencies(dependency))
        .flat(),
    ];
  }

  filterCapturedIssuesBySubset(
    possibleSubset: Issue[],
    sourceIssues: CapturedIssue[]
  ): CapturedIssue[] {
    const c = possibleSubset
      .map((issue) =>
        sourceIssues.find((sourceIssue) => sourceIssue.value.key === issue.key)
      )
      .filter((issue): issue is CapturedIssue => !!issue);

    return c;
  }

  getNestedIssueIncludesDependency(
    issue: Issue,
    possibleDependency: Issue,
    originalIssue = issue
  ): boolean {
    const { dependencies } = issue;

    if (dependencies.has(originalIssue.key)) {
      return true;
    }

    if (issue.key === possibleDependency.key) {
      return false;
    }

    if (!dependencies.size) {
      return false;
    }

    if (dependencies.has(possibleDependency.key)) {
      return true;
    }

    return this.getArrayFromMap(dependencies).some(({ value: dependency }) =>
      this.getNestedIssueIncludesDependency(dependency, possibleDependency)
    );
  }

  getEmptyBuckets(bucketCount: number): Bucket[] {
    return Array.from({ length: bucketCount }, (_, i) => ({
      weight: 0,
      issues: [],
    }));
  }

  getBuckets(issues: Issue[], buckets = this.getEmptyBuckets(10)): Bucket[] {
    const sortedIssues = issues.slice(0).sort(this.compareIssues.bind(this)).sort(this.compareIssueDependencies.bind(this))

    if (!sortedIssues.length) {
      return buckets;
    }

    const skippedIssues: Issue[] = [];

    let pushedIssueToBucket = false;

    sortedIssues.forEach((issue) => {
      if (pushedIssueToBucket) {
        skippedIssues.push(issue);
        return;
      }

      const allCapturedIssues = this.getAllCapturedIssues(buckets);

      const filteredCapturedNestedDependencies = this.filterCapturedIssuesBySubset(
        this.getArrayFromMap(issue.nestedDependencies).map(
          ({ value }) => value
        ),
        allCapturedIssues
      );

      if (filteredCapturedNestedDependencies.length !== issue.nestedDependencies.size) {
        skippedIssues.push(issue);
        return;
      }

      const heaviestCapturedDependency = this.getHeaviestCapturedIssue(
        filteredCapturedNestedDependencies
      );

      const minimumNextBucketWeight = heaviestCapturedDependency?.weightAfter || (this.getLightestBucket(buckets)?.weight ?? 0);

      const heaviestBestCaseBucket = this.getHeaviestBucket(
        buckets.filter(
          (bucket) => bucket.weight <= minimumNextBucketWeight
        )
      );

      const lightestWorstCaseBucket = this.getLightestBucket(buckets);

      const filteredBucket = heaviestBestCaseBucket ?? lightestWorstCaseBucket ?? buckets[0];

      const weightBefore = Math.max(filteredBucket.weight, minimumNextBucketWeight);
      filteredBucket.weight = weightBefore + issue.points;

      filteredBucket.issues.push({
        weightBefore,
        value: issue,
        weightAfter: filteredBucket.weight,
      });

      pushedIssueToBucket = true;
    });

    return this.getBuckets(skippedIssues, buckets);
  }

  getArrayFromMap<K, V>(mapInstance: Map<K, V>): { key: K; value: V }[] {
    return Array.from(mapInstance).map(([key, value]) => ({ key, value }));
  }

  validateDependencies(issueMap: Map<string, Issue>): void {
    this.getArrayFromMap(issueMap).forEach(({ value: issue, key }) => {
      if (issue.key !== key) {
        console.error(issue, key);
        throw new Error('Unexpected mismatch key');
      }

      this.getArrayFromMap(issue.nestedDependencies)
        .map(({ value: dependency }) => dependency)
        .some((dependency) => {
          if (!issueMap.has(dependency.key)) {
            console.error(issue, dependency, key);
            throw new Error('Unexpected dependency not in issueMap');
          }
        });

      if (this.getNestedIssueIncludesDependency(issue, issue)) {
        console.error(issue, key);
        throw new Error('Unexpected circular dependency found');
      }
    });
  }

  //

  handleHover(capturedIssue: CapturedIssueUI | null): void {
    this.hovered$.next(capturedIssue ?? null);
  }

  handleClick(capturedIssue: CapturedIssueUI | null): void {
    this.clicked$.next(capturedIssue ?? null);
  }

  trackByIndex(index: number, _: unknown): number {
    return index;
  }

  trackByCapturedIssue(index: number, capturedIssue: CapturedIssueUI): string {
    return capturedIssue.value.key;
  }

  formatBucketsIntoCsv(buckets: Bucket[]): {fields: string[], csvJson: any[]} {
    const issues = this.getAllCapturedIssues(buckets);

    let i = 0;

    const fields: string[] = [];
    const csvJson: any[] = [];

    while(issues.length) {
      if (i > 100) {
        console.error(fields, csvJson, issues);
        throw new Error("Unexpected inf loop");
      }

      const filteredIssues = issues.filter(issue => issue.weightBefore < POINTS_PER_SPRINT * (i + 1) && issue.weightBefore >= POINTS_PER_SPRINT * i);
      
      if (!filteredIssues.length) {
        break;
      }

      const field = `Sprint ${i + 1}`;
      fields.push(field);

      filteredIssues.forEach(issue => {
        csvJson.push({
          [field]: issue.value.key,
        });
      });

      i++;
    }

    return { fields, csvJson };
  }

  download(buckets: Bucket[]): void {
    const {csvJson, fields} = this.formatBucketsIntoCsv(buckets);
    console.log(csvJson, fields);
    const csvString = parse(csvJson, {
      fields
    });
    console.log(csvString);

    this.downloadAsCSV(csvString, `Sprint Planning - ${POINTS_PER_SPRINT / 2} week sprints`);
  }

  /**
   * source: https://stackoverflow.com/a/24922761
   * @param blob 
   */
  downloadAsCSV(csvFile: string, filename: string): void {
    var blob = new Blob([csvFile], { type: 'text/csv;charset=utf-8;' });
    if ((navigator as any).msSaveBlob) { // IE 10+
        (navigator as any).msSaveBlob(blob, filename);
    } else {
        var link = document.createElement("a");
        if (link.download !== undefined) { // feature detection
            // Browsers that support HTML5 download attribute
            var url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", filename);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }
  }
}
