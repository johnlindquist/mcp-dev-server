// These might be needed by ResourceContent in index.ts

export interface TextResource {
	/** raw text representation of the resource */
	text: string;
	uri: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface BlobResource {
	/** base-64 blob (files, compressed JSON, etc.) */
	uri: string;
	blob: string;
	mimeType?: string;
	[key: string]: unknown;
}
