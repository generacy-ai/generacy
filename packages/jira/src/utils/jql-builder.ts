/**
 * JQL query builder for constructing type-safe JQL queries
 */
export class JqlBuilder {
  private conditions: string[] = [];
  private orderByClause: string[] = [];

  /**
   * Add a condition for project
   */
  project(key: string): this {
    this.conditions.push(`project = "${this.escape(key)}"`);
    return this;
  }

  /**
   * Add a condition for projects (multiple)
   */
  projects(keys: string[]): this {
    const escaped = keys.map((k) => `"${this.escape(k)}"`).join(', ');
    this.conditions.push(`project IN (${escaped})`);
    return this;
  }

  /**
   * Add a condition for issue type
   */
  issueType(type: string): this {
    this.conditions.push(`issuetype = "${this.escape(type)}"`);
    return this;
  }

  /**
   * Add a condition for issue types (multiple)
   */
  issueTypes(types: string[]): this {
    const escaped = types.map((t) => `"${this.escape(t)}"`).join(', ');
    this.conditions.push(`issuetype IN (${escaped})`);
    return this;
  }

  /**
   * Add a condition for status
   */
  status(name: string): this {
    this.conditions.push(`status = "${this.escape(name)}"`);
    return this;
  }

  /**
   * Add a condition for statuses (multiple)
   */
  statuses(names: string[]): this {
    const escaped = names.map((n) => `"${this.escape(n)}"`).join(', ');
    this.conditions.push(`status IN (${escaped})`);
    return this;
  }

  /**
   * Add a condition for status category
   */
  statusCategory(category: 'new' | 'indeterminate' | 'done'): this {
    const categoryMap = {
      new: 'To Do',
      indeterminate: 'In Progress',
      done: 'Done',
    };
    this.conditions.push(`statusCategory = "${categoryMap[category]}"`);
    return this;
  }

  /**
   * Add a condition for assignee
   */
  assignee(accountId: string): this {
    this.conditions.push(`assignee = "${this.escape(accountId)}"`);
    return this;
  }

  /**
   * Add a condition for unassigned issues
   */
  unassigned(): this {
    this.conditions.push('assignee IS EMPTY');
    return this;
  }

  /**
   * Add a condition for reporter
   */
  reporter(accountId: string): this {
    this.conditions.push(`reporter = "${this.escape(accountId)}"`);
    return this;
  }

  /**
   * Add a condition for current user
   */
  assignedToCurrentUser(): this {
    this.conditions.push('assignee = currentUser()');
    return this;
  }

  /**
   * Add a condition for sprint
   */
  sprint(sprintId: number): this {
    this.conditions.push(`sprint = ${sprintId}`);
    return this;
  }

  /**
   * Add a condition for active sprint
   */
  activeSprint(): this {
    this.conditions.push('sprint in openSprints()');
    return this;
  }

  /**
   * Add a condition for future sprints
   */
  futureSprints(): this {
    this.conditions.push('sprint in futureSprints()');
    return this;
  }

  /**
   * Add a condition for labels
   */
  label(label: string): this {
    this.conditions.push(`labels = "${this.escape(label)}"`);
    return this;
  }

  /**
   * Add a condition for labels (multiple, any match)
   */
  labels(labels: string[]): this {
    const escaped = labels.map((l) => `"${this.escape(l)}"`).join(', ');
    this.conditions.push(`labels IN (${escaped})`);
    return this;
  }

  /**
   * Add a condition for priority
   */
  priority(name: string): this {
    this.conditions.push(`priority = "${this.escape(name)}"`);
    return this;
  }

  /**
   * Add a condition for priorities (multiple)
   */
  priorities(names: string[]): this {
    const escaped = names.map((n) => `"${this.escape(n)}"`).join(', ');
    this.conditions.push(`priority IN (${escaped})`);
    return this;
  }

  /**
   * Add a condition for parent issue (epic)
   */
  parent(parentKey: string): this {
    this.conditions.push(`parent = "${this.escape(parentKey)}"`);
    return this;
  }

  /**
   * Add a condition for epic link
   */
  epicLink(epicKey: string): this {
    this.conditions.push(`"Epic Link" = "${this.escape(epicKey)}"`);
    return this;
  }

  /**
   * Add a condition for created date
   */
  createdAfter(date: Date): this {
    this.conditions.push(`created >= "${this.formatDate(date)}"`);
    return this;
  }

  /**
   * Add a condition for created date
   */
  createdBefore(date: Date): this {
    this.conditions.push(`created <= "${this.formatDate(date)}"`);
    return this;
  }

  /**
   * Add a condition for updated date
   */
  updatedAfter(date: Date): this {
    this.conditions.push(`updated >= "${this.formatDate(date)}"`);
    return this;
  }

  /**
   * Add a condition for updated date
   */
  updatedBefore(date: Date): this {
    this.conditions.push(`updated <= "${this.formatDate(date)}"`);
    return this;
  }

  /**
   * Add a condition for due date
   */
  dueBefore(date: Date): this {
    this.conditions.push(`due <= "${this.formatDate(date)}"`);
    return this;
  }

  /**
   * Add a condition for overdue issues
   */
  overdue(): this {
    this.conditions.push('due < now()');
    return this;
  }

  /**
   * Add a text search condition
   */
  text(query: string): this {
    this.conditions.push(`text ~ "${this.escape(query)}"`);
    return this;
  }

  /**
   * Add a summary search condition
   */
  summaryContains(text: string): this {
    this.conditions.push(`summary ~ "${this.escape(text)}"`);
    return this;
  }

  /**
   * Add a raw JQL condition
   */
  raw(condition: string): this {
    this.conditions.push(condition);
    return this;
  }

  /**
   * Add order by clause
   */
  orderBy(field: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    this.orderByClause.push(`${field} ${direction}`);
    return this;
  }

  /**
   * Build the JQL query string
   */
  build(): string {
    let jql = this.conditions.join(' AND ');

    if (this.orderByClause.length > 0) {
      jql += ` ORDER BY ${this.orderByClause.join(', ')}`;
    }

    return jql;
  }

  /**
   * Reset the builder
   */
  reset(): this {
    this.conditions = [];
    this.orderByClause = [];
    return this;
  }

  /**
   * Escape special characters in JQL values
   */
  private escape(value: string): string {
    return value.replace(/"/g, '\\"');
  }

  /**
   * Format date for JQL
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0] ?? '';
  }
}

/**
 * Create a new JQL builder
 */
export function jql(): JqlBuilder {
  return new JqlBuilder();
}
