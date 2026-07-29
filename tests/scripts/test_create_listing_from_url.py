import importlib.util
import json
import pathlib
import subprocess
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[2] / "scripts" / "create_listing_from_url.py"
SPEC = importlib.util.spec_from_file_location("create_listing_from_url", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ListingMetadataTests(unittest.TestCase):
    def test_extracts_json_ld_book_metadata(self):
        source = """
        <html><head><script type="application/ld+json">
        {"@type":"Book","name":"Play Bigger","author":[{"name":"Al Ramadan"},{"name":"Dave Peterson"}],
         "description":"A category design strategy book.","isbn":"9780349414645","publisher":{"name":"Piatkus"}}
        </script></head></html>
        """
        result = MODULE.amazon_metadata_from_html(source)
        self.assertEqual(result["title"], "Play Bigger")
        self.assertEqual(result["authors"], "Al Ramadan, Dave Peterson")
        self.assertEqual(result["isbn"], "9780349414645")
        self.assertEqual(result["publisher"], "Piatkus")

    def test_merge_prefers_rendered_browser_values(self):
        result = MODULE.merge_metadata(
            {"title": "Rendered title", "authors": "", "description": "Rendered description"},
            {"title": "Meta title", "authors": "Book Author", "description": "Meta description"},
        )
        self.assertEqual(result["title"], "Rendered title")
        self.assertEqual(result["authors"], "Book Author")
        self.assertEqual(result["description"], "Rendered description")

    def test_isbn_from_amazon_url(self):
        self.assertEqual(
            MODULE.isbn_from_url("https://www.amazon.in/Play-Bigger/dp/0349414645/ref=test"),
            "0349414645",
        )

    @mock.patch.object(MODULE.subprocess, "run")
    def test_netlify_secret_lookup_is_independent_of_current_folder(self, run):
        run.side_effect = [
            subprocess.CompletedProcess([], 0, json.dumps({"account_id": "acct-1"}), ""),
            subprocess.CompletedProcess(
                [],
                0,
                json.dumps({"values": [{"context": "all", "value": "correct-secret"}]}),
                "",
            ),
        ]

        self.assertEqual(MODULE.netlify_admin_secret("site-1"), "correct-secret")
        self.assertEqual(run.call_args_list[0].args[0][:3], ["netlify", "api", "getSite"])
        self.assertNotIn("cwd", run.call_args_list[0].kwargs)
        second_data = json.loads(run.call_args_list[1].args[0][-1])
        self.assertEqual(second_data, {
            "account_id": "acct-1",
            "site_id": "site-1",
            "key": "ADMIN_SECRET",
        })

    def test_publish_prefers_signed_admin_token_header(self):
        with mock.patch.object(MODULE, "urlopen") as open_url:
            response = mock.MagicMock()
            response.__enter__.return_value = response
            response.__exit__.return_value = False
            response.read.return_value = b'{}'
            open_url.return_value = response
            with mock.patch.object(MODULE.json, "load", return_value={"url": "/product/test/"}):
                MODULE.publish(
                    {"title": "Test"},
                    "https://example.test/create",
                    secret="legacy",
                    admin_token="signed-token",
                )
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header("X-admin-token"), "signed-token")
        self.assertIsNone(request.get_header("X-admin-key"))


if __name__ == "__main__":
    unittest.main()
